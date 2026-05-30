import type { PlatformName } from "./types";

export const platformOrder: PlatformName[] = [
  "wechat",
  "zhihu",
  "bilibili",
  "xiaohongshu",
];

export const platformLabels: Record<PlatformName, string> = {
  wechat: "公众号",
  zhihu: "知乎",
  bilibili: "B站",
  xiaohongshu: "小红书",
};

export const platformDescriptions: Record<PlatformName, string> = {
  wechat: "图文排版、导语和信息密度更偏编辑后台。",
  zhihu: "观点前置、论证结构和问题拆解更重要。",
  bilibili: "强调标题节奏、口语化表达和互动感。",
  xiaohongshu: "更看重体验感、标签氛围和轻量表达。",
};

export const platformAccent: Record<PlatformName, string> = {
  wechat: "blue",
  zhihu: "teal",
  bilibili: "rose",
  xiaohongshu: "amber",
};

export function platformLabel(platform: PlatformName) {
  return platformLabels[platform];
}
