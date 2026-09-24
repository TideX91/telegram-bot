/**
 * The grammy bot: commands, and the one send path the poller uses.
 *
 * The bot half is deliberately thin. It answers a handful of commands and
 * exposes `notify()`; all chain logic lives in `src/poller.ts` and
 * `src/stellar/`.
 */

import { Bot } from "grammy";

import { escapeMd } from "./notifications/format.js";
import { networkLabel, type BotConfig } from "./config.js";
import { contractExplorerUrl } from "./stellar/client.js";
import type { PollerStatus } from "./poller.js";

const HELP = [
  "*Mimir notifier*",
  "",
  "I watch Mimir's two Soroban contracts on Stellar and post every new on-chain event here: claims opened, challenges staked, oracle resolutions, settlements and payouts\\.",
  "",
  "/status — what I am watching and how far I have read",
  "/contracts — the contract ids I watch and where to look them up",
  "/help — this message",
].join("\n");

function ago(timestamp: number | null): string {
  if (timestamp === null) return "never";
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export function statusMessage(config: BotConfig, status: PollerStatus): string {
  const lines: string[] = [
    `*Status* — ${status.running ? "running" : "stopped"} on Stellar ${networkLabel(config)}`,
    "",
    `Chain tip: ${status.latestLedger ?? "unknown"}`,
    `RPC retains from ledger: ${status.oldestLedger ?? "unknown"}`,
    `Poll interval: ${Math.round(config.pollIntervalMs / 1000)}s · last poll ${ago(status.lastPollAt)}`,
    `Cycles: ${status.cycles} · sent ${status.notificationsSent} · failed sends ${status.notificationsFailed} · skipped ${status.eventsSkipped}`,
    "",
    "*Watching*",
  ];

  for (const target of status.targets) {
    lines.push(
      `· mimir\\-${target.source} \`${target.contractId}\``,
      `  last event ledger: ${target.lastEventLedger ?? "none seen"}`,
      `  cursor: \`${target.cursor ?? "none (cold start)"}\``,
    );
    if (target.gapLedgers > 0) {
      // The RPC no longer retains these ledgers, so say what was lost and when
      // the cursor was reset — "none (cold start)" above is the recovery, not
      // the whole story.
      lines.push(
        `  restart gap: ${target.gapLedgers} ledger${target.gapLedgers === 1 ? "" : "s"} unrecoverable` +
          (target.cursorResetAt !== null ? `, cursor reset ${ago(target.cursorResetAt)}` : ""),
      );
    }
    if (target.cursorUnreadable) {
      lines.push(`  cursor ledger unreadable: position left untouched`);
    }
    if (target.lastError) lines.push(`  last error: ${escapeMd(target.lastError)}`);
  }

  if (status.lastError) {
    lines.push(
      "",
      `Last error \\(${ago(status.lastError.at)}\\): ${escapeMd(status.lastError.message)}`,
    );
  }
  if (status.consecutiveFailures > 0) {
    lines.push(`Consecutive failed cycles: ${status.consecutiveFailures}`);
  }
  if (status.restartGaps > 0) {
    lines.push(`Restart gaps detected since start: ${status.restartGaps}`);
  }

  return lines.join("\n");
}

/**
 * The `/contracts` message: which two contracts this bot watches, and where to
 * look each one up independently — deliberately static (config only, no
 * poller state), so it answers the same whether the poller is mid-cycle,
 * between restarts, or wedged on a run of RPC failures. `/status` is for
 * "is it working"; this is for "what is it even watching".
 */
export function contractsMessage(config: BotConfig): string {
  const targets: Array<{ label: string; contractId: string }> = [
    { label: "mimir\\-market", contractId: config.marketContractId },
    { label: "mimir\\-squad", contractId: config.squadContractId },
  ];

  const lines: string[] = [
    `*Contracts* — Mimir on Stellar ${escapeMd(networkLabel(config))}`,
    "",
    "Read\\-only: this bot holds no signing keys and cannot submit transactions\\.",
  ];

  for (const target of targets) {
    lines.push(
      "",
      `*${target.label}*`,
      `\`${escapeMd(target.contractId)}\``,
      `[View on stellar\\.expert](${contractExplorerUrl(config, target.contractId)})`,
    );
  }

  return lines.join("\n");
}

export interface BotDeps {
  config: BotConfig;
  status: () => PollerStatus;
}

export function createBot(deps: BotDeps): Bot {
  const { config, status } = deps;
  const bot = new Bot(config.botToken);

  bot.command("start", async (ctx) => {
    await ctx.reply(HELP, { parse_mode: "MarkdownV2" });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP, { parse_mode: "MarkdownV2" });
  });

  bot.command("status", async (ctx) => {
    await ctx.reply(statusMessage(config, status()), {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
    });
  });

  // Config-only, so this never fails on account of poller or RPC state —
  // unlike /status, it has nothing to report failure on.
  bot.command("contracts", async (ctx) => {
    await ctx.reply(contractsMessage(config), {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
    });
  });

  // grammy rethrows handler errors by default, which would take the process
  // with it. A malformed command must not be fatal.
  bot.catch((err) => {
    console.error(`[bot] handler error on update ${err.ctx.update.update_id}:`, err.error);
  });

  return bot;
}

/** The poller's send path: one message to the configured chat. */
export function createNotifier(bot: Bot, config: BotConfig) {
  return async (text: string): Promise<void> => {
    await bot.api.sendMessage(config.chatId, text, {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
    });
  };
}

/** Registers the command list so Telegram's UI offers autocompletion. */
export async function registerCommands(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands([
      { command: "start", description: "What this bot does" },
      { command: "help", description: "Show help" },
      { command: "status", description: "Last-seen ledger and watched contracts" },
      { command: "contracts", description: "Contract ids and explorer links" },
    ]);
  } catch (err) {
    // Cosmetic. Never worth failing a boot over.
    console.warn(`[bot] setMyCommands failed: ${err instanceof Error ? err.message : err}`);
  }
}
