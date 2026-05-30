"use client";

import { BookOpen, MessageSquareText, Radio, Sparkles } from "lucide-react";

import { platformAccent, platformDescriptions, platformLabel, platformOrder } from "../lib/platforms";
import type { PlatformName } from "../lib/types";

const platformIcons = {
  wechat: BookOpen,
  zhihu: MessageSquareText,
  bilibili: Radio,
  xiaohongshu: Sparkles,
};

export function PlatformPicker({
  value,
  onChange,
}: {
  value: PlatformName[];
  onChange: (platforms: PlatformName[]) => void;
}) {
  function toggle(platform: PlatformName) {
    if (value.includes(platform)) {
      const next = value.filter((item) => item !== platform);
      onChange(next.length > 0 ? next : value);
      return;
    }

    onChange([...value, platform]);
  }

  return (
    <div className="platform-picker">
      {platformOrder.map((platform) => {
        const Icon = platformIcons[platform];
        const selected = value.includes(platform);

        return (
          <button
            key={platform}
            type="button"
            className={selected ? "platform-option selected" : "platform-option"}
            onClick={() => toggle(platform)}
            aria-pressed={selected}
          >
            <span className={`platform-icon ${platformAccent[platform]}`}>
              <Icon size={20} />
            </span>
            <span>
              <strong>{platformLabel(platform)}</strong>
              <small>{platformDescriptions[platform]}</small>
            </span>
          </button>
        );
      })}
    </div>
  );
}
