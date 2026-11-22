// 未服用アラート送信ワーカー(Blazeプラン不要)。
// Firebase Admin SDK で Firestore を確認し、「予定時刻 + 設定した時間」を過ぎても
// 記録がない服薬を、全メンバーに FCM でプッシュ通知する。
// GitHub Actions の定期実行(または自宅PC・Raspberry Pi の cron)から実行する想定。
//
// 動作確認用: 環境変数 TEST_PUSH=true で、アラート条件に関係なく全メンバーへテスト通知を送る。
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const pad = (n) => String(n).padStart(2, '0');
const MIN = 60000;
const DEFAULT_DELAY_MIN = 120;
const DEFAULT_TZ_OFFSET_MIN = 540; // 日本(JST)
// 定期実行の遅延・欠落を吸収できる幅。これより古い未記録はアラートしない。
// GitHub Actions の定期実行は数十分あくことがあるため、2時間まで遡って拾う。
// (送信済みは alerts に記録するので、広げても二重送信にはならない。読み取り回数は少し増える)
const MAX_LATE_MS = 120 * MIN;
const MAX_PER_RUN = 5; // 1グループ1回あたりの最大通知数
const TEST_PUSH = process.env.TEST_PUSH === 'true';

const log = (g, msg) => console.log(`[${g.id}] ${msg}`);

initializeApp({
  credential: process.env.FIREBASE_SERVICE_ACCOUNT
    ? cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    : applicationDefault(),
});

async function main() {
  const db = getFirestore();
  const now = Date.now();
  const groups = await db.collection('groups').get();
  console.log(`グループ数: ${groups.size}${TEST_PUSH ? '(テスト通知モード)' : ''}`);
  for (const g of groups.docs) {
    try {
      if (TEST_PUSH) await sendTest(db, g);
      else await processGroup(db, g, now);
    } catch (e) {
      console.error(`[${g.id}] グループ処理に失敗`, e);
    }
  }
  console.log('完了');
}

// メンバーの FCM トークンと、通知オフにした飲む人を集める
async function loadTargets(db, g) {
  const data = g.data();
  const memberRefs = (data.memberIds || []).map((uid) => db.collection('users').doc(uid));
  const memberDocs = memberRefs.length ? await db.getAll(...memberRefs) : [];
  const targets = []; // { uid, token }
  const mutedByUid = {}; // uid -> 通知オフにした飲む人のID
  for (const u of memberDocs) {
    const d = u.exists ? u.data() : {};
    mutedByUid[u.id] = d.mutedProfiles || [];
    const tokens = d.fcmTokens || [];
    log(g, `メンバー ${u.id}: ユーザー情報=${u.exists ? 'あり' : 'なし'} / FCMトークン=${tokens.length}件`);
    for (const token of tokens) targets.push({ uid: u.id, token });
  }
  return { targets, mutedByUid };
}

// 送信結果をログに出し、無効なトークンを掃除する
async function send(db, g, recipients, message) {
  const resp = await getMessaging().sendEachForMulticast({
    tokens: recipients.map((t) => t.token),
    ...message,
  });
  log(g, `送信結果: 成功 ${resp.successCount}件 / 失敗 ${resp.failureCount}件`);
  resp.responses.forEach((r, i) => {
    if (!r.success) log(g, `  失敗(メンバー ${recipients[i].uid}): ${r.error && r.error.code} ${r.error && r.error.message}`);
  });
  await removeInvalidTokens(db, recipients, resp);
}

async function sendTest(db, g) {
  const { targets } = await loadTargets(db, g);
  if (targets.length === 0) {
    log(g, '送信先がありません(アプリで通知を許可し、ログイン後に一度アプリを開いてください)');
    return;
  }
  await send(db, g, targets, {
    notification: { title: 'テスト通知', body: 'kusurip のアラート送信テストです' },
    android: { priority: 'high', notification: { channelId: 'dose_alert' } },
    apns: { payload: { aps: { sound: 'default' } } },
  });
}

async function processGroup(db, g, now) {
  const data = g.data();
  if (data.alertsEnabled === false) {
    log(g, '未服用アラートがオフのためスキップ');
    return;
  }

  const delayMs = (data.alertDelayMinutes || DEFAULT_DELAY_MIN) * MIN;
  const offsetMs = (data.tzOffsetMinutes ?? DEFAULT_TZ_OFFSET_MIN) * MIN;

  const medSnap = await g.ref.collection('medications').get();
  const meds = medSnap.docs.filter((d) => d.data().active !== false && !d.data().isPrn);
  log(g, `「${data.name}」 遅延=${delayMs / MIN}分 / 有効な定時のお薬=${meds.length}件`);
  if (meds.length === 0) return;

  // グループの現地日付(「現地時刻をUTCとして見た」ミリ秒で扱う)
  const localNow = new Date(now + offsetMs);
  const todayStart = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());
  const dayStarts = [todayStart, todayStart - 24 * 60 * MIN]; // 今日と昨日(日またぎ対策)

  // まず「アラート対象の時間帯に入っている予定」を、お薬の設定だけから洗い出す(読み取りを節約)
  const candidates = [];
  let beforeCreated = 0;
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
        const late = now - schedMs;
        if (late < delayMs || late >= delayMs + MAX_LATE_MS) continue;
        // お薬の登録より前の時刻の予定は対象外(登録直後の誤アラート防止)
        if (schedMs < createdMs) {
          beforeCreated++;
          continue;
        }
        // クライアントの doseIdFor() と同じ形式
        const id = `${med.id}_${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(hh)}${pad(mm)}`;
        candidates.push({ id, med: m, schedMs, time: `${pad(hh)}:${pad(mm)}` });
      }
    }
  }
  log(
    g,
    `アラート対象の時間帯にある予定=${candidates.length}件` +
      (beforeCreated ? `(お薬の登録前の時刻のため除外: ${beforeCreated}件)` : ''),
  );
  if (candidates.length === 0) {
    log(g, '→ 予定時刻から設定した遅延(+2時間以内)の間にある未記録の予定がありません');
    return;
  }

  // 対象があるときだけ、記録・送信済み・名前を読む
  const refs = candidates.map((c) => g.ref.collection('doses').doc(c.id));
  const alertRefs = candidates.map((c) => g.ref.collection('alerts').doc(c.id));
  const [doseDocs, alertDocs, profileSnap] = await Promise.all([
    db.getAll(...refs),
    db.getAll(...alertRefs),
    g.ref.collection('profiles').get(),
  ]);
  const profileNames = Object.fromEntries(profileSnap.docs.map((d) => [d.id, d.data().name || '']));
  const takenCount = doseDocs.filter((d) => d.exists).length;
  const alertedCount = alertDocs.filter((d) => d.exists).length;
  const overdue = candidates
    .filter((_, i) => !doseDocs[i].exists && !alertDocs[i].exists)
    .sort((a, b) => a.schedMs - b.schedMs);
  log(g, `記録済み=${takenCount}件 / 送信済み=${alertedCount}件 / 今回の送信対象=${overdue.length}件`);
  if (overdue.length === 0) return;

  const { targets, mutedByUid } = await loadTargets(db, g);
  log(g, `送信先トークン合計=${targets.length}件`);

  for (const o of overdue.slice(0, MAX_PER_RUN)) {
    // この飲む人の通知をオフにしているメンバーには送らない
    const recipients = targets.filter((t) => !(mutedByUid[t.uid] || []).includes(o.med.profileId));
    if (recipients.length > 0) {
      const who = profileNames[o.med.profileId] || '';
      await send(db, g, recipients, {
        notification: {
          title: '服薬の確認',
          body: `${who}さんの${o.med.name}(${o.time}の予定)がまだ記録されていません`,
        },
        data: { groupId: g.id, doseId: o.id },
        android: { priority: 'high', notification: { channelId: 'dose_alert' } },
        apns: { payload: { aps: { sound: 'default' } } },
      });
    } else {
      log(g, `${o.med.name}(${o.time}): 送信先がないため送信なし(トークン未登録、または通知オフ)`);
    }
    // 送信済みを記録(送信先がなくても記録して、毎回の再判定を避ける)
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
