import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const runtimeDir = path.join(root, ".runtime");
let apiBaseUrl = process.env.E2E_API_BASE_URL ?? "";

fs.mkdirSync(runtimeDir, { recursive: true });

function tail(filePath) {
  if (!fs.existsSync(filePath)) {
    return "";
  }

  const content = fs.readFileSync(filePath, "utf8");
  return content.slice(Math.max(0, content.length - 5000));
}

function startService(name, args, extraEnv = {}) {
  const stdoutPath = path.join(runtimeDir, `${name}-e2e.out.log`);
  const stderrPath = path.join(runtimeDir, `${name}-e2e.err.log`);
  const stdout = fs.openSync(stdoutPath, "w");
  const stderr = fs.openSync(stderrPath, "w");
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: {
      ...process.env,
      REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6380",
      ...extraEnv,
    },
    stdio: ["ignore", stdout, stderr],
  });

  fs.closeSync(stdout);
  fs.closeSync(stderr);
  return { name, child, stdoutPath, stderrPath };
}

async function stopService(service) {
  if (!service || service.child.exitCode !== null) {
    return;
  }

  service.child.kill("SIGTERM");
  const timeout = delay(3000).then(() => {
    if (service.child.exitCode === null) {
      service.child.kill("SIGKILL");
    }
  });

  await Promise.race([once(service.child, "exit"), timeout]);
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, options);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${options.method ?? "GET"} ${pathname} failed: ${response.status} ${body}`);
  }

  return response.json();
}

async function waitForApi(api) {
  for (let i = 0; i < 40; i += 1) {
    if (api.child.exitCode !== null) {
      throw new Error(`API exited early.\n${tail(api.stderrPath)}`);
    }

    try {
      return await requestJson("/health");
    } catch {
      await delay(500);
    }
  }

  throw new Error(`API health check did not become ready.\n${tail(api.stderrPath)}`);
}

function ensureBuildOutput() {
  for (const filePath of ["apps/api/dist/main.js", "apps/worker/dist/main.js"]) {
    if (!fs.existsSync(path.join(root, filePath))) {
      throw new Error(`Missing ${filePath}. Run pnpm build before pnpm test:publish-flow.`);
    }
  }
}

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Free port probe did not expose a TCP address.");
  }

  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

ensureBuildOutput();

const apiPort = process.env.E2E_API_BASE_URL ? undefined : await getFreePort();
const queueName = `mp-publishing-publish-flow-e2e-${Date.now()}`;
apiBaseUrl = apiBaseUrl || `http://127.0.0.1:${apiPort}`;
const e2eEnv = {
  ...(apiPort ? { PORT: String(apiPort) } : {}),
  PUBLISH_QUEUE_NAME: queueName,
};

const api = startService("api", ["apps/api/dist/main.js"], e2eEnv);
const worker = startService("worker", ["apps/worker/dist/main.js"], e2eEnv);

try {
  await waitForApi(api);

  const accountsResponse = await requestJson("/accounts");
  const healthyAccounts = accountsResponse.items
    .filter((account) => account.health === "healthy")
    .slice(0, 2);

  if (healthyAccounts.length === 0) {
    throw new Error("No healthy demo accounts are available for publish flow verification.");
  }

  const created = await requestJson("/publish/simulate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      document: {
        title: "Prisma BullMQ 发布闭环验证",
        summary: "验证 API 创建任务、BullMQ 入队、worker 消费、Postgres 状态回写。",
        body: "这是一条自动化验证内容，用来确认发布链路已经从本地 runtime demo 切换到数据库和队列。",
        tags: ["e2e", "prisma", "bullmq"],
      },
      platforms: healthyAccounts.map((account) => account.platform),
      accountIds: healthyAccounts.map((account) => account.id),
      toneMode: "keep",
      preserveOriginal: true,
    }),
  });

  let task = created;
  for (let i = 0; i < 50; i += 1) {
    await delay(600);
    task = await requestJson(`/publish/tasks/${created.id}`);
    if (!["running", "queued"].includes(task.status)) {
      break;
    }
  }

  let runtime = await requestJson("/runtime/status");
  for (let i = 0; i < 20; i += 1) {
    if (runtime.queue.waiting === 0 && runtime.queue.active === 0 && runtime.queue.delayed === 0) {
      break;
    }

    await delay(300);
    runtime = await requestJson("/runtime/status");
  }

  const result = {
    taskId: created.id,
    finalStatus: task.status,
    overallStatus: task.overallStatus,
    targets: task.results.map((target) => ({
      platform: target.platform,
      status: target.status,
      ok: target.ok,
      attempts: target.attemptCount,
    })),
    worker: runtime.worker,
    queue: runtime.queue,
  };

  console.log(JSON.stringify(result, null, 2));

  if (task.status !== "succeeded") {
    throw new Error(`Publish flow task did not succeed: ${task.status}`);
  }

  if (runtime.queue.failed > 0 || runtime.queue.waiting > 0 || runtime.queue.active > 0) {
    throw new Error(`Publish queue is not drained: ${JSON.stringify(runtime.queue)}`);
  }
} catch (error) {
  console.error(error);
  console.error("API stderr tail:\n", tail(api.stderrPath));
  console.error("Worker stderr tail:\n", tail(worker.stderrPath));
  process.exitCode = 1;
} finally {
  await Promise.all([stopService(api), stopService(worker)]);
}
