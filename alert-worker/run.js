// 未服用アラート送信ワーカー(Blazeプラン不要)。
// Firebase Admin SDK で Firestore を確認し、「予定時刻 + 設定した時間」を過ぎても
// 記録がない服薬を、全メンバーに FCM でプッシュ通知する。
// GitHub Actions の定期実行(または自宅PC・Raspberry Pi の cron)から 15分ごとに実行する想定。
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const pad = (n) => String(n).padStart(2, '0');
const MIN = 60000;
const DEFAULT_DELAY_MIN = 120;
const DEFAULT_TZ_OFFSET_MIN = 540; // 日本(JST)
// 実行間隔(15分)+ 定期実行の遅延を吸収できる幅。これより古い未記録はアラートしない。
// 幅を狭くすると Firestore の読み取り回数も減る(無料枠: 1日5万読み取り)。
const MAX_LATE_MS = 60 * MIN;
const MAX_PER_RUN = 5; // 1グループ1回あたりの最大通知数

initializeApp({
  credential: process.env.FIREBASE_SERVICE_ACCOUNT
    ? cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    : applicationDefault(),
});

async function main() {
  const db = getFirestore();
  const now = Date.now();
  const groups = await db.collection('groups').get();
  for (const g of groups.docs) {
    try {
      await processGroup(db, g, now);
    } catch (e) {
      console.error('グループ処理に失敗', g.id, e);
    }
  }
  console.log(`完了: ${groups.size} グループを確認`);
}

async function processGroup(db, g, now) {
  const data = g.data();
  if (data.alertsEnabled === false) return;

  const delayMs = (data.alertDelayMinutes || DEFAULT_DELAY_MIN) * MIN;
  const offsetMs = (data.tzOffsetMinutes ?? DEFAULT_TZ_OFFSET_MIN) * MIN;

  const medSnap = await g.ref.collection('medications').get();
  const meds = medSnap.docs.filter((d) => d.data().active !== false && !d.data().isPrn);
  if (meds.length === 0) return;

  // グループの現地日付(「現地時刻をUTCとして見た」ミリ秒で扱う)
  const localNow = new Date(now + offsetMs);
  const todayStart = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());
  const dayStarts = [todayStart, todayStart - 24 * 60 * MIN]; // 今日と昨日(日またぎ対策)

  // まず「アラート対象の時間帯に入っている予定」を、お薬の設定だけから洗い出す(読み取りを節約)
  const candidates = [];
  for (const med of meds) {
    const m = med.data();
    const weekdays = m.weekdays && m.weekdays.length ? m.weekdays : [1, 2, 3, 4, 5, 6, 7];
    const createdMs = m.createdAt ? m.createdAt.toMillis() : 0;
    for (const dayStart of dayStarts) {
      const d = new Date(dayStart);
      const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // 月=1 ... 日=7(アプリと同じ)
      if (!weekdays.includes(weekday)) continue;
      for (const t of m.times || []) {
        const [hh, mm] = t.split(':').map(Number);
        const schedMs = dayStart + (hh * 60 + mm) * MIN - offsetMs;
        // お薬の登録より前の時刻の予定は対象外(登録直後の誤アラート防止)
        if (schedMs < createdMs) continue;
        const late = now - schedMs;
        if (late < delayMs || late >= delayMs + MAX_LATE_MS) continue;
        // クライアントの doseIdFor() と同じ形式
        const id = `${med.id}_${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(hh)}${pad(mm)}`;
        candidates.push({ id, med: m, schedMs, time: `${pad(hh)}:${pad(mm)}` });
      }
    }
  }
  if (candidates.length === 0) return;

  // 対象があるときだけ、記録・送信済み・名前を読む
  const refs = candidates.map((c) => g.ref.collection('doses').doc(c.id));
  const alertRefs = candidates.map((c) => g.ref.collection('alerts').doc(c.id));
  const [doseDocs, alertDocs, profileSnap] = await Promise.all([
    db.getAll(...refs),
    db.getAll(...alertRefs),
    g.ref.collection('profiles').get(),
  ]);
  const profileNames = Object.fromEntries(profileSnap.docs.map((d) => [d.id, d.data().name || '']));
  const overdue = candidates
    .filter((_, i) => !doseDocs[i].exists && !alertDocs[i].exists)
    .sort((a, b) => a.schedMs - b.schedMs);
  if (overdue.length === 0) return;

  // 通知先: 全メンバーのFCMトークン
  const memberRefs = (data.memberIds || []).map((uid) => db.collection('users').doc(uid));
  const memberDocs = memberRefs.length ? await db.getAll(...memberRefs) : [];
  const targets = []; // { uid, token }
  for (const u of memberDocs) {
    for (const token of (u.exists && u.data().fcmTokens) || []) targets.push({ uid: u.id, token });
  }

  for (const o of overdue.slice(0, MAX_PER_RUN)) {
    if (targets.length > 0) {
      const who = profileNames[o.med.profileId] || '';
      const resp = await getMessaging().sendEachForMulticast({
        tokens: targets.map((t) => t.token),
        notification: {
          title: '服薬の確認',
          body: `${who}さんの${o.med.name}(${o.time}の予定)がまだ記録されていません`,
        },
        data: { groupId: g.id, doseId: o.id },
        android: { priority: 'high', notification: { channelId: 'dose_alert' } },
        apns: { payload: { aps: { sound: 'default' } } },
      });
      await removeInvalidTokens(db, targets, resp);
    }
    // 送信済みを記録(トークンがなくても記録して、毎回の再判定を避ける)
    await g.ref.collection('alerts').doc(o.id).set({
      scheduledAt: Timestamp.fromMillis(o.schedMs),
      sentAt: FieldValue.serverTimestamp(),
    });
  }
}

// 無効になったトークンを users から取り除く
async function removeInvalidTokens(db, targets, resp) {
  const bad = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'];
  await Promise.all(
    resp.responses.map((r, i) => {
      if (!r.success && r.error && bad.includes(r.error.code)) {
        return db.collection('users').doc(targets[i].uid).update({
          fcmTokens: FieldValue.arrayRemove(targets[i].token),
        });
      }
      return null;
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
