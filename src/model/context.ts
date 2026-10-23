import { buildSystemPrompt } from "../claude/system-prompt.ts";
import type { Config } from "../config/config.ts";
import { collectIntegrationInstructions } from "../integrations/host.ts";
import * as intSettings from "../integrations/settings.ts";
import type { Orchestrator } from "../orchestrators/registry.ts";
import {
  type SessionKey,
  chatIdFromKey,
  isGroupSession,
  isMirrorSession,
  isTradingSession,
} from "../sessions/key.ts";

type PromptInput = {
  sessionKey: SessionKey;
  senderLabel: string;
  senderHandle: string | null;
  sandboxPath: string;
  guest?: {
    tier: "keyed-guest" | "vouched";
    campaignContextPath: string | null;
  };
};

/** Build the provider-neutral prompt shared by Claude Code and Codex. */
export function buildRunSystemPrompt(
  input: PromptInput,
  config: Config,
  orchestrator: Orchestrator | null,
): string {
  const isGroup = isGroupSession(input.sessionKey);
  const isTrading = isTradingSession(input.sessionKey);
  const isGuest = input.guest != null;
  return buildSystemPrompt({
    senderLabel: input.senderLabel,
    senderHandle: input.senderHandle,
    ownerName: config.owner.name,
    isGroup,
    isMirror: isMirrorSession(input.sessionKey),
    chatGuid: isGroup ? chatIdFromKey(input.sessionKey) : null,
    sandboxPath: input.sandboxPath,
    separateVenuePrompts: config.behavior.separate_group_prompts,
    integrationInstructions: isGuest
      ? []
      : collectIntegrationInstructions(
          { sessionKey: input.sessionKey, handle: input.senderHandle },
          config,
        ),
    radarOmegaEnabled: intSettings.radaromega(config).enabled,
    orchestrator: orchestrator ? { key: orchestrator.key, name: orchestrator.name } : null,
    guestTier: input.guest?.tier ?? null,
    campaignContextPath: input.guest?.campaignContextPath ?? null,
    isTrading,
    tradingConfig: isTrading
      ? {
          accountNumber: intSettings.trading(config).account_number,
          cashFloor: intSettings.trading(config).cash_floor,
          maxPositionPct: intSettings.trading(config).max_position_pct,
          maxOrderUsd: intSettings.trading(config).max_order_usd,
          maxOrdersPerRun: intSettings.trading(config).max_orders_per_run,
          killNav: intSettings.trading(config).kill_nav,
          preferLimit: intSettings.trading(config).prefer_limit,
          universe: intSettings.trading(config).universe,
        }
      : undefined,
  });
}
