// Loaded into a page — an agent's or a workspace's — two frames below the
// test's window, by a test that needs to know whether a request to another
// host was made at all.
parent.parent.postMessage({ signal: "script" }, "*");
