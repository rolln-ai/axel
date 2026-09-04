// A distinct pair of loopback ports lets each worktree own its test servers.
// Reusing a server could silently test another checkout, so the config refuses it.
export const qaPortBase = Number(process.env.AXEL_QA_PORT_BASE ?? "34100");
if (!Number.isInteger(qaPortBase) || qaPortBase < 1024 || qaPortBase > 65534) {
  throw new Error("AXEL_QA_PORT_BASE must be an integer from 1024 to 65534");
}

export const origins = {
  marketing: `http://127.0.0.1:${qaPortBase}`,
  dashboard: `http://127.0.0.1:${qaPortBase + 1}`,
};
