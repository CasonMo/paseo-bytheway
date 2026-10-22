import { defineTranslations } from "@getpaseo/plugin/client";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

/** 宿主 App 语言的翻译资源；UI 注册与面板/设置共用。 */
export const messages = defineTranslations({
  resources: {
    en,
    "zh-CN": zhCN,
  },
});
