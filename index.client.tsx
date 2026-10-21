import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerSidekickUi } from "./client/ui-registration";

export default function contribute(client: PluginClientContext) {
  return registerSidekickUi(client);
}
