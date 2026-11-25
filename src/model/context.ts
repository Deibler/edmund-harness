import type { Config } from "../config/config.ts";
import { collectIntegrationInstructions } from "../integrations/host.ts";
import * as intSettings from "../integrations/settings.ts";
import {
  type SessionKey,
  chatIdFromKey,
  isGroupSession,
  isMirrorSession,
} from "../sessions/key.ts";
import { buildSystemPrompt } from "./system-prompt.ts";

type PromptInput = {
  sessionKey: SessionKey;
  senderLabel: string;
  senderHandle: string | null;
  sandboxPath: string;
  guest?: {
    tier: "keyed-guest" | "vouched";
    campaignContextPath: string | null;
    loadout: "guest" | "allowlisted";
  };
};

/** Build the provider-neutral prompt shared by Claude Code and Codex. */
export function buildRunSystemPrompt(input: PromptInput, config: Config): string {
  const isGroup = isGroupSession(input.sessionKey);
  const isGuest = input.guest != null && input.guest.loadout !== "allowlisted";
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
    guestTier: input.guest?.tier ?? null,
    guestLoadout: input.guest?.loadout ?? null,
    campaignContextPath: input.guest?.campaignContextPath ?? null,
  });
}
