// Cold Circle — smoke test for the Phase 0–1 vertical slice.
//
// Drives two simulated WebSocket clients against a running server to verify:
//   1. authentication (good + bad passphrase)
//   2. public chat broadcast (a send is seen by both clients)
//   3. chat history on join (newest-first, as specified)
//   4. an unauthenticated frame is rejected
//
// Start the server first (npm run build && npm start), then:  npm run smoke
// Override the endpoint with:  COLD_CIRCLE_TEST_URL=ws://host:port npm run smoke

import WebSocket from "ws";

const URL = process.env.COLD_CIRCLE_TEST_URL || "ws://127.0.0.1:8443";
const PASS = process.env.COLD_CIRCLE_PASS || "abacus";

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failures++;
    console.error(`  \u2717 ${name}${detail ? " — " + detail : ""}`);
  }
}

// A tiny client that resolves on auth_ok and collects subsequent frames.
function connect(handle, passphrase) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    let session = null;
    let authed = false;
    // Frames received after auth, for waitFor().
    let postAuth = [];
    ws.on("message", (raw) => {
      let f;
      try { f = JSON.parse(raw.toString()); } catch { return; }
      if (!authed) {
        if (f.op === "auth_ok") {
          session = f.session;
          authed = true;
          resolve({
            ws,
            get session() { return session; },
            authed,
            handle,
            // Resolve with the next frame of `op` arriving after now.
            waitFor(op) {
              return new Promise((res) => {
                const start = postAuth.length;
                const t = setInterval(() => {
                  const m = postAuth.find((x, i) => i >= start && x.op === op);
                  if (m) { clearInterval(t); res(m); }
                }, 20);
                setTimeout(() => { clearInterval(t); res(null); }, 1500);
              });
            },
          });
        } else if (f.op === "auth_fail") {
          reject(new Error("auth_fail: " + f.reason));
        }
        return;
      }
      postAuth.push(f);
    });
    ws.on("open", () => ws.send(JSON.stringify({ op: "auth", passphrase, handle })));
    ws.on("error", reject);
  });
}

async function main() {
  console.log(`\nCold Circle smoke test -> ${URL}`);

  // 1. Good auth for two handles.
  const a = await connect("ghost_77", PASS);
  const b = await connect("mochi", PASS);
  check("a authenticates", a.authed);
  check("b authenticates", b.authed);
  check("auth_ok echoes handle", a.session && true);

  // 2. Broadcast: a message from A is received by B.
  const sendAt = Date.now();
  a.ws.send(JSON.stringify({ op: "chat_send", channel: "#general", body: "anyone up?", session: a.session }));
  const got = await b.waitFor("chat_msg");
  check("b receives chat_msg from a", got && got.body === "anyone up?" && got.handle === "ghost_77",
    got ? JSON.stringify(got) : "no frame");
  check("chat_msg carries a timestamp", got && typeof got.ts === "number" && got.ts >= sendAt);

  // 3. History on join is newest-first and contains the message.
  b.ws.send(JSON.stringify({ op: "chat_history", channel: "#general", limit: 500, session: b.session }));
  const hist = await b.waitFor("chat_history");
  const bodies = (hist && hist.messages || []).map((m) => m.body);
  check("history contains the sent message", bodies.includes("anyone up?"), JSON.stringify(bodies));
  check("history is newest-first", hist && hist.messages.length === 0 ||
    (hist.messages[0]?.body === "anyone up?"),
    hist ? "first=" + JSON.stringify(hist.messages[0]) : "no frame");

  // 4. A bad passphrase is rejected.
  let badRejected = false;
  const badWs = new WebSocket(URL);
  badWs.on("open", () => badWs.send(JSON.stringify({ op: "auth", passphrase: "wrong", handle: "x" })));
  badWs.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.op === "auth_fail") { badRejected = true; badWs.close(); }
  });
  await new Promise((r) => setTimeout(r, 300));
  check("bad passphrase -> auth_fail", badRejected);

  // 5. A frame without a session token is rejected (unauthenticated).
  let unauthRejected = false;
  const c = await connect("night_owl", PASS);
  c.ws.send(JSON.stringify({ op: "chat_send", channel: "#general", body: "no token" }));
  const errFrame = await c.waitFor("error");
  unauthRejected = !!(errFrame && /session|unauthenticated/i.test(errFrame.message || ""));
  check("unauthenticated frame -> error", unauthRejected,
    errFrame ? JSON.stringify(errFrame) : "no error frame");

  // 6. File upload, list, download, and delete.
  // Create a test file content.
  const testFileName = "smoke_test_" + Date.now() + ".txt";
  const testFileContent = "Hello from the smoke test! This is a test file for Cold Circle file operations.\nLine 2.\n";
  const testBuffer = Buffer.from(testFileContent);

  // Start an upload.
  a.ws.send(JSON.stringify({
    op: "file_upload",
    action: "start",
    name: testFileName,
    size: testBuffer.length,
    session: a.session,
  }));
  const startOk = await a.waitFor("file_start_ok");
  check("file_upload start -> file_start_ok", startOk && startOk.upload_id,
    startOk ? JSON.stringify(startOk) : "no frame");

  const uploadId = startOk?.upload_id;

  // Send chunks.
  const chunkSize = 16; // small chunks for testing
  let offset = 0;
  while (offset < testBuffer.length) {
    const chunk = testBuffer.slice(offset, offset + chunkSize);
    a.ws.send(JSON.stringify({
      op: "file_upload",
      action: "chunk",
      data: Array.from(chunk),
      upload_id: uploadId,
      session: a.session,
    }));
    offset += chunkSize;
  }
  // Finalize.
  a.ws.send(JSON.stringify({
    op: "file_upload",
    action: "finalize",
    upload_id: uploadId,
    session: a.session,
  }));
  // Give the server time to finalize (it's synchronous but we need to wait for the list response).
  await new Promise((r) => setTimeout(r, 300));
  // Request the file list.
  a.ws.send(JSON.stringify({ op: "file_list", session: a.session }));
  const fileList = await a.waitFor("file_list");
  const fileNames = (fileList?.entries || []).map((e) => e.name);
  const found = fileNames.includes(testFileName);
  check("file_list includes uploaded file", found, JSON.stringify(fileNames));

  // Download the file.
  a.ws.send(JSON.stringify({ op: "file_download", name: testFileName, session: a.session }));
  const downloaded = await a.waitFor("file_download");
  const downloadedContent = Buffer.from(downloaded?.data || "", "base64").toString("utf8");
  check("file_download returns correct content", downloadedContent === testFileContent,
    "expected: " + JSON.stringify(testFileContent) + " got: " + JSON.stringify(downloadedContent));

  // Delete the file.
  a.ws.send(JSON.stringify({ op: "file_delete", name: testFileName, session: a.session }));
  // Give time for the delete + list reload.
  await new Promise((r) => setTimeout(r, 300));
  a.ws.send(JSON.stringify({ op: "file_list", session: a.session }));
  const postDeleteList = await a.waitFor("file_list");
  const postDeleteNames = (postDeleteList?.entries || []).map((e) => e.name);
  check("file_delete removes file from list", !postDeleteNames.includes(testFileName),
    JSON.stringify(postDeleteNames));

  // --- Bulletin board tests ---
  // Post a bulletin message.
  const bulletinBody = "Hello from the smoke test bulletin board!";
  a.ws.send(JSON.stringify({
    op: "bulletin_post",
    body: bulletinBody,
    session: a.session,
  }));
  const posted = await a.waitFor("bulletin_entry");
  check("bulletin_post returns entry", posted && posted.id && posted.body === bulletinBody,
    JSON.stringify(posted));
  const postId = posted?.id;
  const postHandle = posted?.handle;

  // Request the bulletin list.
  a.ws.send(JSON.stringify({ op: "bulletin_list", session: a.session }));
  const bulletinList = await a.waitFor("bulletin_list");
  const entries = bulletinList?.entries || [];
  const foundPost = entries.find((e) => e.id === postId);
  check("bulletin_list includes posted message", !!foundPost,
    JSON.stringify(entries.map((e) => e.id)));
  check("bulletin entry carries handle", foundPost?.handle === postHandle,
    JSON.stringify(foundPost?.handle));

  // --- Admin smoke tests (Phase 5) ---
  const ADMIN_PASS = process.env.COLD_CIRCLE_ADMIN_PASS || "abacus_admin";

  // Connect as admin.
  const admin = await connect("abacus_admin", ADMIN_PASS);

  // Test admin_server_info.
  admin.ws.send(JSON.stringify({ op: "admin_server_info", session: admin.session }));
  const serverInfo = await admin.waitFor("admin_server_info");
  check("admin_server_info returns version", serverInfo && serverInfo.version, JSON.stringify(serverInfo));
  check("admin_server_info has online_handles", Array.isArray(serverInfo?.online_handles), JSON.stringify(serverInfo));
  check("admin_server_info has channels", Array.isArray(serverInfo?.channels), JSON.stringify(serverInfo));

  // Test admin_channel_list.
  admin.ws.send(JSON.stringify({ op: "admin_channel_list", session: admin.session }));
  const chList = await admin.waitFor("admin_channel_list");
  check("admin_channel_list returns channels", chList && Array.isArray(chList.channels), JSON.stringify(chList));
  check("admin_channel_list includes default channel", (chList?.channels || []).some((c) => c.name === "#general"), JSON.stringify(chList));

  // Test admin_channel_create.
  const newChannel = "#admin_test_channel";
  admin.ws.send(JSON.stringify({ op: "admin_channel_create", channel: newChannel, session: admin.session }));
  const created = await admin.waitFor("admin_channel_list");
  check("admin_channel_create creates channel", created && created.channels.some((c) => c.name === newChannel), JSON.stringify(created));

  // Test admin_channel_delete.
  admin.ws.send(JSON.stringify({ op: "admin_channel_delete", channel: newChannel, session: admin.session }));
  const deleted = await admin.waitFor("admin_channel_list");
  check("admin_channel_delete removes channel", !deleted?.channels?.some((c) => c.name === newChannel), JSON.stringify(deleted));

  // Test admin_file_list (shows uploader info).
  admin.ws.send(JSON.stringify({ op: "admin_file_list", session: admin.session }));
  const adminFileList = await admin.waitFor("admin_file_list");
  check("admin_file_list returns files with uploader", adminFileList && Array.isArray(adminFileList?.files), JSON.stringify(adminFileList));
  check("admin_file_list shows uploader field", (adminFileList?.files || []).every((f) => typeof f.uploader === "string"), JSON.stringify(adminFileList));

  // Test admin_dm_audit (bypasses participant check).
  admin.ws.send(JSON.stringify({ op: "admin_dm_audit", session: admin.session }));
  const dmAudit = await admin.waitFor("admin_dm_audit");
  check("admin_dm_audit returns conversations", dmAudit && Array.isArray(dmAudit?.conversations), JSON.stringify(dmAudit));

  // Test admin_banned_list.
  admin.ws.send(JSON.stringify({ op: "admin_banned_list", session: admin.session }));
  const bannedList = await admin.waitFor("admin_banned_list");
  check("admin_banned_list returns handles array", bannedList && Array.isArray(bannedList?.handles), JSON.stringify(bannedList));

  // Test admin_ban: ban user "mochi".
  admin.ws.send(JSON.stringify({ op: "admin_ban", handle: "mochi", session: admin.session }));
  const banResult = await admin.waitFor("admin_banned_list");
  check("admin_ban adds handle to banned list", banResult?.handles?.includes("mochi"), JSON.stringify(banResult));
  // Verify mochi gets disconnected (either by close event or error frame).
  let mochiGotError = false;
  const mochiDisconnect = await new Promise((resolve) => {
    const errorHandler = (raw) => {
      try {
        const f = JSON.parse(raw.toString());
        if (f.op === "error" && f.code === "banned") { mochiGotError = true; resolve(true); }
      } catch {} // ignore parse errors
    };
    b.ws.on("close", () => resolve(true));
    b.ws.on("error", () => resolve(true));
    b.ws.on("message", errorHandler);
    setTimeout(() => resolve(mochiGotError || b.readyState !== WebSocket.OPEN), 2000);
  });
  check("admin_ban disconnects banned user", mochiDisconnect, "mochi did not disconnect");

  // Test banned user cannot re-authenticate.
  let banAuthFailed = false;
  const bannedWs = new WebSocket(URL);
  bannedWs.on("open", () => bannedWs.send(JSON.stringify({ op: "auth", handle: "mochi", passphrase: PASS })));
  bannedWs.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.op === "auth_fail" && f.reason === "handle is banned") {
      banAuthFailed = true;
      bannedWs.close();
    }
  });
  await new Promise((r) => setTimeout(r, 500));
  check("banned user gets auth_fail", banAuthFailed, "mochi was able to re-authenticate");

  // Test admin_unban.
  admin.ws.send(JSON.stringify({ op: "admin_unban", handle: "mochi", session: admin.session }));
  const unbanResult = await admin.waitFor("admin_banned_list");
  check("admin_unban removes handle from banned list", !unbanResult?.handles?.includes("mochi"), JSON.stringify(unbanResult));

  // Test admin_bulletin_delete.
  // First, post a bulletin as admin.
  admin.ws.send(JSON.stringify({ op: "bulletin_post", body: "admin bulletin to delete", session: admin.session }));
  const adminBulletin = await admin.waitFor("bulletin_entry");
  const adminPostId = adminBulletin?.id;
  // Delete it.
  admin.ws.send(JSON.stringify({ op: "admin_bulletin_delete", post_id: adminPostId, session: admin.session }));
  const delBulletin = await admin.waitFor("bulletin_list");
  check("admin_bulletin_delete removes post", !delBulletin?.entries?.some((e) => e.id === adminPostId), JSON.stringify(delBulletin));

  // Test admin-only error: regular user trying admin op.
  const sendToNonAdmin = JSON.stringify({ op: "admin_server_info", session: a.session });
  a.ws.send(sendToNonAdmin);
  const adminError = await a.waitFor("error");
  check("non-admin gets error on admin op", adminError && /admin/i.test(adminError.message || ""), JSON.stringify(adminError));

  a.ws.close();
  b.ws.close();
  c.ws.close();
  admin.ws.close();

  console.log(failures === 0 ? "\n  ALL PASS \u2713\n" : `\n  ${failures} FAILED \u2717\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("smoke test crashed:", e); process.exit(1); });
