/** @jsxImportSource react */

/**
 * Openrind Shell host credentials — DATABASE_URL, ANTHROPIC_API_KEY and the
 * optional OPENRIND_GATEWAY_API_KEY — surfaced on the Environment settings page
 * so every key the app needs lives in one place.
 *
 * Storage is deliberately NOT the workspace environment store: these values
 * are encrypted at rest via the OS keyring (Electron safeStorage), decrypted
 * only for trusted Desktop/OpenShell host services, and never sent to the
 * renderer once saved. The workspace environment variables above them,
 * by contrast, live in the Openrind Desktop server and are injected into chat
 * engine runs — moving secrets there would both weaken their protection and
 * break sandboxes when no workspace server is running.
 */

import { useState } from "react";

import { Button } from "../../../design-system/button";
import type {
  OpenrindShellCredentialKey,
  OpenrindShellCredentialStatus,
} from "../state/openshell-state";

const settingsPanelClass =
  "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";

export type CredentialRowProps = {
  label: string;
  description: string;
  placeholder: string;
  statusKey: OpenrindShellCredentialKey;
  status: OpenrindShellCredentialStatus | null;
  busy: boolean;
  onSet: (value: string) => Promise<void>;
  onClear: () => Promise<void>;
  extra?: React.ReactNode;
  configureLabel?: string;
  verticalActions?: boolean;
};

export function CredentialRow(props: CredentialRowProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const isSet = props.status?.[props.statusKey] === "set";

  const submit = async () => {
    if (!value.trim()) return;
    setLocalError(null);
    try {
      await props.onSet(value);
      setValue("");
      setEditing(false);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  const cancel = () => {
    setValue("");
    setEditing(false);
    setLocalError(null);
  };

  return (
    <div className="rounded-2xl border border-dls-border bg-dls-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-12">{props.label}</span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${isSet
                  ? "border-green-7/60 bg-green-3/30 text-green-12"
                  : "border-gray-7/50 bg-gray-2/40 text-gray-10"
                }`}
            >
              {isSet ? "Set" : "Not set"}
            </span>
          </div>
          <div className="text-xs text-gray-9">{props.description}</div>
        </div>
        <div className={`flex shrink-0 ${props.verticalActions ? "flex-col items-stretch sm:items-end gap-1.5" : "items-center gap-2"}`}>
          {props.extra}
          {!editing ? (
            <>
              <Button
                variant="outline"
                className="h-7 rounded-full px-3 text-xs"
                onClick={() => setEditing(true)}
                disabled={props.busy}
              >
                {isSet ? "Update" : (props.configureLabel || "Configure")}
              </Button>
              {isSet ? (
                <Button
                  variant="outline"
                  className="h-7 rounded-full border-red-7/50 px-3 text-xs text-red-12 hover:bg-red-2/30"
                  onClick={() => void props.onClear()}
                  disabled={props.busy}
                >
                  Clear
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {editing ? (
        <div className="mt-3 space-y-2">
          <input
            type="password"
            className="w-full rounded-lg border border-dls-border bg-dls-surface px-2 py-1.5 font-mono text-xs"
            value={value}
            placeholder={props.placeholder}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape") cancel();
            }}
          />
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              className="h-7 rounded-full px-3 text-xs"
              onClick={() => void submit()}
              disabled={props.busy || !value.trim()}
            >
              Save
            </Button>
            <Button
              variant="outline"
              className="h-7 rounded-full px-3 text-xs"
              onClick={cancel}
              disabled={props.busy}
            >
              Cancel
            </Button>
          </div>
          {localError ? (
            <div className="text-xs text-red-11">{localError}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export type OpenrindShellCredentialsPanelProps = {
  credentialStatus: OpenrindShellCredentialStatus | null;
  actionBusy: boolean;
  onSetCredential: (key: OpenrindShellCredentialKey, value: string) => Promise<void>;
  onClearCredential: (key: OpenrindShellCredentialKey) => Promise<void>;
};

export function OpenrindShellCredentialsPanel(props: OpenrindShellCredentialsPanelProps) {
  return (
    <div className={`${settingsPanelClass} space-y-4`}>
      <div>
        <div className="text-sm font-medium text-gray-12">Sandbox credentials</div>
        <div className="text-xs text-gray-10">
          Secrets used by Desktop to provision Openrind Shell and its required Haloop
          edge. Unlike the workspace environment variables above, these are encrypted
          at rest by your OS keyring (Keychain / DPAPI / libsecret), used only by
          trusted Desktop/OpenShell host-side services, and never returned to the UI
          once saved.
        </div>
      </div>
      {props.credentialStatus && props.credentialStatus.encryptionAvailable === false ? (
        <div className="rounded-xl border border-amber-7/50 bg-amber-2/30 p-3 text-xs text-amber-12">
          The OS keyring isn't available in this session. Openrind Shell credentials cannot be stored
          securely until you launch from a graphical session (or install gnome-keyring /
          kwallet on Linux).
        </div>
      ) : null}
      <CredentialRow
        label="DATABASE_URL"
        description="PostgreSQL connection string (Supabase / Neon / firm-internal). Required for any Openrind Shell sandbox."
        placeholder="postgresql://user:password@host:5432/dbname"
        statusKey="databaseUrl"
        status={props.credentialStatus}
        busy={props.actionBusy}
        onSet={(v) => props.onSetCredential("databaseUrl", v)}
        onClear={() => props.onClearCredential("databaseUrl")}
      />
      <CredentialRow
        label="ANTHROPIC_API_KEY"
        description="Upstream Anthropic API key required by the host-managed Haloop edge. Desktop retains it outside the sandbox; Claude and OpenClaw receive neither this key nor a direct-provider route."
        placeholder="sk-ant-..."
        statusKey="anthropicApiKey"
        status={props.credentialStatus}
        busy={props.actionBusy}
        onSet={(v) => props.onSetCredential("anthropicApiKey", v)}
        onClear={() => props.onClearCredential("anthropicApiKey")}
      />
      <CredentialRow
        label="OPENRIND_GATEWAY_API_KEY"
        description="Openrind account and billing credential. It is not an inference route; Claude and OpenClaw always use the required Haloop edge."
        placeholder="sk-st-..."
        statusKey="openrindGatewayApiKey"
        status={props.credentialStatus}
        busy={props.actionBusy}
        onSet={(v) => props.onSetCredential("openrindGatewayApiKey", v)}
        onClear={() => props.onClearCredential("openrindGatewayApiKey")}
        configureLabel="Already have a key"
        verticalActions={true}
        extra={
          props.credentialStatus?.openrindGatewayApiKey === "unset" ? (
            <Button
              variant="outline"
              className="h-7 rounded-full px-3 text-xs border-blue-7/50 bg-blue-3/10 text-blue-12 hover:bg-blue-3/30"
              onClick={() => window.open("https://app.openrind.com/sign-in?intent=shell", "_blank")}
              disabled={props.actionBusy}
            >
              Sign Up
            </Button>
          ) : null
        }
      />
      <CredentialRow
        label="ELEVENLABS_API_KEY"
        description="ElevenLabs API key used by voice dictation in the composer and sandbox terminal."
        placeholder="sk_..."
        statusKey="elevenLabsApiKey"
        status={props.credentialStatus}
        busy={props.actionBusy}
        onSet={(v) => props.onSetCredential("elevenLabsApiKey", v)}
        onClear={() => props.onClearCredential("elevenLabsApiKey")}
      />
    </div>
  );
}
