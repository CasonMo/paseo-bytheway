import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export interface LocalClient {
  daemon: DaemonClient;
  client: PaseoApi;
}

/** 连接本机 daemon：0.16 起用 localCredential，而不是把 local-credential 当 password。 */
export async function connectLocalClient(
  clientId: string,
  url = "ws://127.0.0.1:6767/ws",
): Promise<LocalClient> {
  const credential = readFileSync(
    join(homedir(), ".paseo", "local-credential"),
    "utf8",
  ).trim();
  const daemon = new DaemonClient({
    url,
    clientId,
    clientType: "cli",
    localCredential: () => credential,
    reconnect: { enabled: false },
  });
  await daemon.connect();
  return { daemon, client: createPaseoApi(daemon) };
}
