// Cloudflare Workers の Cron Trigger から、GitHub Actions のワークフローを手動実行する。
// GitHub の schedule は時刻が不安定なので、時刻管理だけを Cloudflare に任せる。
// 実際のアラート処理(alert-worker/run.js)は、これまでどおり GitHub Actions で動く。
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(dispatchWorkflow(env));
  },
};

async function dispatchWorkflow(env) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.WORKFLOW_FILE}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'kusurip-cron', // GitHub API は User-Agent が必須
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: env.GITHUB_REF }),
  });
  // 成功は 204。それ以外はログ(Cloudflare ダッシュボードの Logs)に残す
  if (res.status !== 204) {
    console.error(`dispatch 失敗: ${res.status} ${await res.text()}`);
  }
}
