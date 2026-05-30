import type {
  AdaptOptions,
  PlatformAdapter,
  PlatformCapabilities,
  PlatformDraft,
  PlatformCredential,
  PublishInput,
  PublishResult,
  PublishStatus,
  PublishStatusInput,
  SimulationResult,
  ValidationIssue,
} from "@mp-publishing/platform-sdk";

declare const process: {
  env: Record<string, string | undefined>;
};

const capabilities: PlatformCapabilities = {
  platform: "wechat",
  titleMaxLength: 64,
  summaryMaxLength: 120,
  supportedBlocks: [
    "title",
    "subtitle",
    "paragraph",
    "heading",
    "blockquote",
    "list",
    "image",
    "imageGallery",
    "linkCard",
    "cta",
  ],
  supportsHtml: true,
  supportsMarkdown: false,
  supportsHashtags: false,
  supportsScheduling: true,
  publishMode: "official-api",
};

type WechatApiError = {
  errcode?: number;
  errmsg?: string;
};

type WechatTokenResponse = WechatApiError & {
  access_token?: string;
  expires_in?: number;
};

type WechatDraftResponse = WechatApiError & {
  media_id?: string;
};

type WechatFreePublishResponse = WechatApiError & {
  publish_id?: string;
};

type WechatFreePublishStatusResponse = WechatApiError & {
  publish_id?: string;
  publish_status?: number;
  article_id?: string;
  article_detail?: {
    count?: number;
    item?: Array<{
      idx?: number;
      article_url?: string;
    }>;
  };
  fail_idx?: number[];
};

function createIssue(code: string, message: string, severity: ValidationIssue["severity"] = "error"): ValidationIssue {
  return {
    code,
    message,
    severity,
  };
}

function readEnvValue(key: string) {
  const value = process.env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function isEnabled(key: string) {
  return readEnvValue(key)?.toLowerCase() === "true";
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, Math.max(maxLength - 3, 1))}...` : value;
}

function extractBodySegments(document: PublishInput["document"]): string[] {
  return document.blocks.flatMap((block) => {
    if (block.text) {
      return [block.text];
    }

    if (block.items) {
      return block.items;
    }

    return [];
  });
}

function renderWechatHtml(document: PublishInput["document"]) {
  const html = document.blocks
    .map((block) => {
      if (block.type === "heading" && block.text) {
        const level = block.level && block.level >= 1 && block.level <= 3 ? block.level : 2;
        return `<h${level}>${escapeHtml(block.text)}</h${level}>`;
      }

      if (block.type === "blockquote" && block.text) {
        return `<blockquote>${escapeHtml(block.text)}</blockquote>`;
      }

      if (block.type === "list" && block.items) {
        return `<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
      }

      if (block.text) {
        return `<p>${escapeHtml(block.text).replace(/\n/g, "<br />")}</p>`;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");

  return html || `<p>${escapeHtml(document.summary ?? document.title)}</p>`;
}

function buildPreviewBody(document: PublishInput["document"]) {
  const intro = document.summary ?? "适合公众号图文排版的导语预览。";
  return [intro, ...extractBodySegments(document)].join("\n\n");
}

async function requestWechatJson<T extends WechatApiError>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const payload = (await response.json()) as T;
  if (!response.ok) {
    throw new Error(`WeChat API HTTP ${response.status}: ${payload.errmsg ?? response.statusText}`);
  }

  if (typeof payload.errcode === "number" && payload.errcode !== 0) {
    throw new Error(`WeChat API ${payload.errcode}: ${payload.errmsg ?? "unknown error"}`);
  }

  return payload;
}

async function resolveAccessToken(credential?: PlatformCredential) {
  if (!credential) {
    throw new Error("missing WeChat credential");
  }

  if (credential.accessToken) {
    return credential.accessToken;
  }

  if (!credential.appId || !credential.appSecret) {
    throw new Error("missing WeChat appId/appSecret or accessToken");
  }

  const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
  url.searchParams.set("appid", credential.appId);
  url.searchParams.set("secret", credential.appSecret);
  url.searchParams.set("grant_type", "client_credential");

  const payload = await requestWechatJson<WechatTokenResponse>(url.toString());
  if (!payload.access_token) {
    throw new Error("WeChat token response did not include access_token");
  }

  return payload.access_token;
}

function buildWechatArticle(input: PublishInput) {
  const thumbMediaId = readEnvValue("WECHAT_DEFAULT_THUMB_MEDIA_ID");
  if (!thumbMediaId) {
    throw new Error("missing WECHAT_DEFAULT_THUMB_MEDIA_ID");
  }

  return {
    article_type: "news",
    title: truncate(input.document.title, capabilities.titleMaxLength ?? 64),
    author: truncate(readEnvValue("WECHAT_ARTICLE_AUTHOR") ?? input.document.metadata.authorId, 8),
    digest: truncate(input.document.summary ?? extractBodySegments(input.document)[0] ?? input.document.title, 120),
    content: renderWechatHtml(input.document),
    content_source_url: readEnvValue("WECHAT_CONTENT_SOURCE_URL") ?? "",
    thumb_media_id: thumbMediaId,
    need_open_comment: isEnabled("WECHAT_NEED_OPEN_COMMENT") ? 1 : 0,
    only_fans_can_comment: isEnabled("WECHAT_ONLY_FANS_CAN_COMMENT") ? 1 : 0,
  };
}

async function createWechatDraft(input: PublishInput) {
  const accessToken = await resolveAccessToken(input.credential);
  const url = new URL("https://api.weixin.qq.com/cgi-bin/draft/add");
  url.searchParams.set("access_token", accessToken);

  const payload = await requestWechatJson<WechatDraftResponse>(url.toString(), {
    method: "POST",
    body: JSON.stringify({
      articles: [buildWechatArticle(input)],
    }),
  });

  if (!payload.media_id) {
    throw new Error("WeChat draft response did not include media_id");
  }

  return payload.media_id;
}

async function submitWechatPublish(input: PublishInput, mediaId: string) {
  const accessToken = await resolveAccessToken(input.credential);
  const url = new URL("https://api.weixin.qq.com/cgi-bin/freepublish/submit");
  url.searchParams.set("access_token", accessToken);

  const payload = await requestWechatJson<WechatFreePublishResponse>(url.toString(), {
    method: "POST",
    body: JSON.stringify({
      media_id: mediaId,
    }),
  });

  if (!payload.publish_id) {
    throw new Error("WeChat publish response did not include publish_id");
  }

  return payload.publish_id;
}

async function queryWechatPublishStatus(publishId: string, input?: PublishStatusInput): Promise<WechatFreePublishStatusResponse> {
  const accessToken = await resolveAccessToken(input?.credential);
  const url = new URL("https://api.weixin.qq.com/cgi-bin/freepublish/get");
  url.searchParams.set("access_token", accessToken);

  return requestWechatJson<WechatFreePublishStatusResponse>(url.toString(), {
    method: "POST",
    body: JSON.stringify({
      publish_id: publishId,
    }),
  });
}

function mapWechatPublishStatus(payload: WechatFreePublishStatusResponse): PublishStatus {
  const firstArticle = payload.article_detail?.item?.find((item) => item.article_url);

  if (payload.publish_status === 0) {
    return {
      state: "succeeded",
      detail: "WeChat reports the publish job succeeded.",
      remoteId: payload.article_id ?? payload.publish_id,
      url: firstArticle?.article_url,
    };
  }

  if (payload.publish_status === 1) {
    return {
      state: "publishing",
      detail: "WeChat reports the publish job is still running.",
      remoteId: payload.publish_id,
    };
  }

  if (payload.publish_status === 2) {
    return {
      state: "needs_manual_action",
      detail: "WeChat original-content review failed.",
      remoteId: payload.publish_id,
      issues: [createIssue("WECHAT_ORIGINAL_REVIEW_FAILED", `Original review failed for article indexes: ${payload.fail_idx?.join(", ") || "unknown"}.`, "warning")],
    };
  }

  if (payload.publish_status === 4) {
    return {
      state: "needs_manual_action",
      detail: "WeChat platform review did not pass.",
      remoteId: payload.publish_id,
      issues: [createIssue("WECHAT_PLATFORM_REVIEW_FAILED", `Platform review failed for article indexes: ${payload.fail_idx?.join(", ") || "unknown"}.`, "warning")],
    };
  }

  if (payload.publish_status === 5 || payload.publish_status === 6) {
    return {
      state: "needs_manual_action",
      detail: "WeChat reports articles were removed or banned after publishing.",
      remoteId: payload.publish_id,
      issues: [createIssue("WECHAT_POST_PUBLISH_UNAVAILABLE", "Published WeChat articles are no longer available.", "warning")],
    };
  }

  return {
    state: "failed",
    detail: `WeChat reports publish failure status ${payload.publish_status ?? "unknown"}.`,
    remoteId: payload.publish_id,
    issues: [createIssue("WECHAT_PUBLISH_FAILED", `WeChat publish_status=${payload.publish_status ?? "unknown"}.`)],
  };
}

export const wechatAdapter: PlatformAdapter = {
  platform: "wechat",
  getCapabilities() {
    return capabilities;
  },
  async validate(document) {
    const issues: ValidationIssue[] = [];

    if (document.title.length > (capabilities.titleMaxLength ?? 64)) {
      issues.push(createIssue("TITLE_TOO_LONG", "Title exceeds wechat recommendation length.", "warning"));
    }

    if (document.assets.length === 0) {
      issues.push(createIssue("MISSING_VISUAL_ASSET", "wechat preview currently has no visual asset attached.", "info"));
    }

    if (!document.summary) {
      issues.push(
        createIssue("MISSING_SUMMARY", "wechat preview is using an auto-generated lead paragraph because summary is empty.", "info"),
      );
    }

    return issues;
  },
  async adapt(document, options: AdaptOptions): Promise<PlatformDraft> {
    const warnings = await this.validate(document);

    return {
      platform: "wechat",
      title: options.preserveOriginal ? document.title : truncate(document.title, capabilities.titleMaxLength ?? 64),
      summary: document.summary ?? "适合公众号图文排版的导语预览。",
      body: buildPreviewBody(document),
      hashtags: [...document.metadata.topics.map((topic) => `#${topic}`), "#公众号排版"],
      warnings,
    };
  },
  async simulatePublish(input: PublishInput): Promise<SimulationResult> {
    const issues = await this.validate(input.document);

    if (!input.credential) {
      issues.push(createIssue("WECHAT_CREDENTIAL_MISSING", "WeChat credential is not configured; real draft creation will require it.", "warning"));
    }

    if (!readEnvValue("WECHAT_DEFAULT_THUMB_MEDIA_ID")) {
      issues.push(
        createIssue("WECHAT_THUMB_MEDIA_ID_MISSING", "WECHAT_DEFAULT_THUMB_MEDIA_ID is required before creating a real WeChat draft.", "warning"),
      );
    }

    return {
      ok: issues.every((issue) => issue.severity !== "error"),
      screenshots: ["simulation://wechat/compose"],
      issues,
    };
  },
  async publish(input: PublishInput): Promise<PublishResult> {
    const issues = await this.validate(input.document);

    if (input.dryRun) {
      return {
        ok: true,
        remoteId: "dry-run-wechat",
        url: "https://example.com/published/wechat",
        issues,
      };
    }

    if (!isEnabled("WECHAT_REAL_PUBLISH_ENABLED")) {
      return {
        ok: false,
        issues: [
          ...issues,
          createIssue(
            "WECHAT_REAL_PUBLISH_DISABLED",
            "Set WECHAT_REAL_PUBLISH_ENABLED=true before allowing the adapter to call WeChat draft APIs.",
          ),
        ],
      };
    }

    try {
      const mediaId = await createWechatDraft(input);

      if (!isEnabled("WECHAT_SUBMIT_FREEPUBLISH")) {
        return {
          ok: true,
          remoteId: mediaId,
          url: `wechat://draft/${mediaId}`,
          issues: [
            ...issues,
            createIssue("WECHAT_DRAFT_CREATED", "A real WeChat draft was created; public publish was not submitted.", "info"),
          ],
        };
      }

      const publishId = await submitWechatPublish(input, mediaId);
      return {
        ok: true,
        remoteId: publishId,
        url: `wechat://freepublish/${publishId}`,
        issues: [
          ...issues,
          createIssue("WECHAT_FREEPUBLISH_SUBMITTED", "WeChat freepublish submission was accepted; poll status or consume webhook next.", "info"),
        ],
      };
    } catch (error) {
      return {
        ok: false,
        issues: [
          ...issues,
          createIssue("WECHAT_API_ERROR", error instanceof Error ? error.message : "Unknown WeChat API error."),
        ],
      };
    }
  },
  async getPublishStatus(remoteId: string, input?: PublishStatusInput) {
    try {
      const payload = await queryWechatPublishStatus(remoteId, input);
      return mapWechatPublishStatus(payload);
    } catch (error) {
      return {
        state: "needs_manual_action",
        detail: error instanceof Error ? error.message : "Unknown WeChat status query error.",
        remoteId,
        issues: [createIssue("WECHAT_STATUS_QUERY_FAILED", error instanceof Error ? error.message : "Unknown WeChat status query error.", "warning")],
      };
    }
  },
};
