import { PageTitle } from "@/components/PageTitle";
import { Paper } from "@/components/Sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { post } from "@/lib/api";
import type { PortalPageData } from "@/types";
import { useState } from "react";
import { toast } from "sonner";

type Action = "wipe-media" | "wipe-files" | "reset-convo" | "erase-all";

export function Privacy({ data, reload }: { data: PortalPageData; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState<Action | null>(null);
  const [typed, setTyped] = useState("");
  const notes = data.isGroup ? "" : "his notes about you, ";

  const run = async (action: Action) => {
    setBusy(action);
    const r = await post<{ summary?: string }>(`/privacy/${action}`, {
      confirm: action === "erase-all" ? typed.trim() : true,
    });
    setBusy(null);
    setTyped("");
    if (!r.ok) return toast.error(r.error);
    toast.success(r.summary ?? "Done");
    await reload();
  };

  const Confirm = ({
    action,
    button,
    title,
    body,
    requireWord,
  }: {
    action: Action;
    button: string;
    title: string;
    body: string;
    requireWord?: string;
  }) => (
    <AlertDialog onOpenChange={(open) => !open && setTyped("")}>
      <AlertDialogTrigger
        render={
          <Button
            variant="destructive"
            disabled={busy !== null}
            className="h-11 w-full text-[15px] sm:h-10 sm:w-auto sm:px-5"
          />
        }
      >
        {busy === action ? "Working…" : button}
      </AlertDialogTrigger>
      <AlertDialogContent className="bg-card">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-heading text-xl">{title}</AlertDialogTitle>
          <AlertDialogDescription className="text-[15px] leading-relaxed">
            {body}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {requireWord ? (
          <div className="px-1">
            <label htmlFor="confirm-word" className="mb-1 block text-[13px] text-muted-foreground">
              Type {requireWord} to confirm
            </label>
            <Input
              id="confirm-word"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoCapitalize="characters"
              className="h-11 text-[16px]"
            />
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel className="h-11 sm:h-10">Keep it</AlertDialogCancel>
          <AlertDialogAction
            disabled={requireWord ? typed.trim() !== requireWord : false}
            onClick={() => run(action)}
            className="h-11 bg-destructive text-white hover:bg-destructive/90 sm:h-10"
          >
            {button}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return (
    <div>
      <PageTitle
        title="Privacy"
        lede="What Edmund keeps for this conversation, and how to delete it. Every action here is immediate and permanent."
      />

      <Paper title="What is stored">
        <p className="text-[15px] leading-relaxed">
          For this chat Edmund keeps a private workspace of files and media he made or received,{" "}
          {data.isGroup ? "" : "a notes file about you (see Memory), "}a searchable index of the
          conversation so he can recall past context, your settings from this page, your schedules,
          and a log of his proactive messages.
        </p>
        <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
          The Messages thread itself lives on your phone and Apple's servers. Deleting data here
          does not touch your Messages app.
        </p>
      </Paper>

      <Paper
        title="Wipe media"
        description="Every image, video, voice memo and received attachment in this chat's workspace."
      >
        <Confirm
          action="wipe-media"
          button="Delete all media"
          title="Delete all media?"
          body="Every image, video, voice memo and received attachment for this chat is removed from Edmund's workspace. This cannot be undone."
        />
      </Paper>

      <Paper
        title="Delete files and artifacts"
        description="Documents, notes and working files. Media stays unless you wipe it too."
      >
        <Confirm
          action="wipe-files"
          button="Delete files and artifacts"
          title="Delete files and artifacts?"
          body="The documents, notes and working files in this chat's workspace are removed. Media stays. This cannot be undone."
        />
      </Paper>

      <Paper
        title="Reset the conversation"
        description={`Edmund starts the next exchange with a blank slate. ${data.isGroup ? "" : "His notes about you survive a reset."}`}
      >
        <Confirm
          action="reset-convo"
          button="Reset conversation memory"
          title="Reset the conversation?"
          body="The running thread context is dropped and Edmund starts fresh on the next message."
        />
      </Paper>

      <Paper
        title="Erase everything"
        description={`The full wipe: workspace, media, ${notes}search index, proactive-message history, your schedules and the running conversation. Your settings on this page, and this link, survive.`}
      >
        <Confirm
          action="erase-all"
          button="Erase everything"
          title="Erase everything for this chat?"
          body="Workspace, media, notes, search index, history, schedules and the running conversation are all removed. This cannot be undone."
          requireWord="ERASE"
        />
      </Paper>
    </div>
  );
}
