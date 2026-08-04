/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { Boxes, Settings, X } from "lucide-react";
import { useNavigate } from "react-router-dom";

import type { SandboxProfile } from "../../../../app/lib/desktop";
import {
  modalBodyClass,
  modalHeaderButtonClass,
  modalHeaderClass,
  modalOverlayClass,
  modalShellClass,
  modalTitleClass,
  inputClass,
  inputLabelClass,
  pillPrimaryClass,
  pillGhostClass,
} from "../../workspace/modal-styles";
import { writeSandboxProfile } from "../../session/sidebar/sandbox-prefs";
import { deriveSandboxName } from "../../session/sidebar/use-sandbox-rows";

type CredentialStatus = {
  databaseUrl: "set" | "unset" | "unknown";
  openrindShellAgent: string | null;
  openrindGatewayApiBase: string | null;
};

export type CreateSandboxModalProps = {
  open: boolean;
  onClose: () => void;
  existingNames: string[];
};

export function CreateSandboxModal(props: CreateSandboxModalProps) {
  const navigate = useNavigate();

  const [profile, setProfile] = useState<SandboxProfile>("openrind-shell-claude");
  const [newName, setNewName] = useState("");
  const [creds, setCreds] = useState<CredentialStatus | null>(null);

  // Reset form when modal opens
  useEffect(() => {
    if (props.open) {
      setNewName("");
      setProfile("openrind-shell-claude");

      const bridge = window.__OPENRIND_DESKTOP_ELECTRON__;
      if (bridge?.invokeDesktop) {
        bridge.invokeDesktop("openrindCredentialStatus")
          .then((status) => setCreds(status as CredentialStatus))
          .catch(() => setCreds(null));
      }
    }
  }, [props.open]);

  const dbReady = creds?.databaseUrl === "set";
  const dbBlocked = creds !== null && !dbReady;

  const previewName = useMemo(() => deriveSandboxName(newName), [newName]);
  const nameTaken = useMemo(
    () => Boolean(previewName) && props.existingNames.includes(previewName),
    [previewName, props.existingNames]
  );

  const canCreate = Boolean(previewName) && !nameTaken && !dbBlocked;

  const handleCreate = () => {
    if (!canCreate) return;
    writeSandboxProfile(previewName, profile);
    props.onClose();
    navigate("/session", {
      state: { openrindSandbox: { name: previewName, profile } },
    });
  };

  if (!props.open) return null;

  return (
    <div className={modalOverlayClass} onClick={props.onClose}>
      <div
        className={`${modalShellClass} max-w-[560px]`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={modalHeaderClass}>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover text-dls-accent">
              <Boxes size={20} />
            </div>
            <div>
              <h2 className={modalTitleClass}>New sandbox</h2>
              <div className="mt-1 text-[13px] text-dls-secondary">
                Initialize a new persistent, postgres-backed agent sandbox.
              </div>
            </div>
          </div>
          <button
            type="button"
            className={modalHeaderButtonClass}
            onClick={props.onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className={modalBodyClass}>
          {creds !== null && !dbReady ? (
            <div className="mb-6 flex items-start gap-3 rounded-2xl border border-amber-7/40 bg-amber-2/20 p-4 text-amber-12">
              <Settings size={16} className="mt-0.5 shrink-0" />
              <div className="flex-1 text-[13px]">
                <div className="font-medium">DATABASE_URL is not configured</div>
                <div className="opacity-90 mt-1">
                  Openrind Shell sandboxes need a PostgreSQL connection for persistence. Set it before creating one.
                </div>
              </div>
              <button
                type="button"
                className={`${pillGhostClass} border-amber-7/50 text-amber-12 hover:bg-amber-2/40`}
                onClick={() => {
                  props.onClose();
                  navigate("/settings/environment");
                }}
              >
                Configure
              </button>
            </div>
          ) : null}

          <div className="space-y-4">
            <div>
              <label className={`mb-1.5 block ${inputLabelClass}`}>Sandbox name</label>
              <input
                className={inputClass}
                placeholder="my-project"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canCreate) handleCreate();
                }}
              />
              {nameTaken ? (
                <div className="mt-2 text-[13px] text-amber-11">
                  A sandbox with this name already exists.
                </div>
              ) : previewName ? (
                <div className="mt-2 text-[13px] text-dls-secondary">
                  Creates <code className="rounded bg-gray-2/40 px-1 py-0.5 text-[11px]">{previewName}</code>
                </div>
              ) : null}
            </div>
            <div>
              <label className={`mb-1.5 block ${inputLabelClass}`}>Agent</label>
              <select
                className={inputClass}
                value={profile}
                onChange={(e) => setProfile(e.target.value as SandboxProfile)}
              >
                <option value="openrind-shell-claude">Claude Code</option>
                <option value="openrind-shell-openclaw">OpenClaw</option>
              </select>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-3 border-t border-dls-border px-6 py-5">
          <button
            type="button"
            className="rounded-full px-4 py-2 text-[13px] font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className={pillPrimaryClass}
            onClick={handleCreate}
            disabled={!canCreate}
          >
            Create &amp; launch
          </button>
        </div>
      </div>
    </div>
  );
}
