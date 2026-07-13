/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

import { currentLocale, t } from "../../../i18n";
import {
  errorBannerClass,
  modalBodyClass,
  modalHeaderButtonClass,
  modalHeaderClass,
  modalOverlayClass,
  modalShellClass,
  modalSubtitleClass,
  modalTitleClass,
  pillGhostClass,
  pillPrimaryClass,
} from "./modal-styles";
import { RemoteWorkspaceFields } from "./remote-workspace-fields";
import type { CreateRemoteWorkspaceModalProps } from "./types";

export function CreateRemoteWorkspaceModal(
  props: CreateRemoteWorkspaceModalProps,
) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const translate = (key: string) => t(key, currentLocale());

  const [openrindDesktopHostUrl, setOpenrindDesktopHostUrl] = useState("");
  const [openrindDesktopToken, setOpenrindDesktopToken] = useState("");
  const [openrindDesktopTokenVisible, setOpenrindDesktopTokenVisible] = useState(false);
  const [directory, setDirectory] = useState("");
  const [displayName, setDisplayName] = useState("");

  const showClose = props.showClose ?? true;
  const title = props.title ?? translate("dashboard.create_remote_workspace_title");
  const subtitle =
    props.subtitle ?? translate("dashboard.create_remote_workspace_subtitle");
  const confirmLabel =
    props.confirmLabel ?? translate("dashboard.create_remote_workspace_confirm");
  const isInline = props.inline ?? false;
  const submitting = props.submitting ?? false;

  const canSubmit = useMemo(() => {
    if (submitting) return false;
    return openrindDesktopHostUrl.trim().length > 0;
  }, [openrindDesktopHostUrl, submitting]);

  useEffect(() => {
    if (!props.open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const defaults = props.initialValues ?? {};
    setOpenrindDesktopHostUrl(defaults.openrindDesktopHostUrl?.trim() ?? "");
    setOpenrindDesktopToken(defaults.openrindDesktopToken?.trim() ?? "");
    setOpenrindDesktopTokenVisible(false);
    setDirectory(defaults.directory?.trim() ?? "");
    setDisplayName(defaults.displayName?.trim() ?? "");
  }, [props.initialValues, props.open]);

  if (!props.open && !isInline) {
    return null;
  }

  const content = (
    <div className={`${modalShellClass} max-w-[560px]`}>
      <div className={modalHeaderClass}>
        <div className="min-w-0">
          <h3 className={modalTitleClass}>{title}</h3>
          <p className={modalSubtitleClass}>{subtitle}</p>
        </div>
        {showClose ? (
          <button
            onClick={props.onClose}
            disabled={submitting}
            className={modalHeaderButtonClass}
          >
            <X size={18} />
          </button>
        ) : null}
      </div>

      <div className={modalBodyClass}>
        <RemoteWorkspaceFields
          hostUrl={openrindDesktopHostUrl}
          onHostUrlInput={setOpenrindDesktopHostUrl}
          token={openrindDesktopToken}
          tokenVisible={openrindDesktopTokenVisible}
          onTokenInput={setOpenrindDesktopToken}
          onToggleTokenVisible={() =>
            setOpenrindDesktopTokenVisible((prev) => !prev)
          }
          displayName={displayName}
          onDisplayNameInput={setDisplayName}
          directory={directory}
          onDirectoryInput={setDirectory}
          showDirectory
          submitting={submitting}
          hostInputRef={inputRef}
          title="Remote server details"
          description="Use the URL your Openrind Desktop server shared with you. Add a token only if the server needs one."
        />
      </div>

      <div className="space-y-3 border-t border-dls-border px-6 py-5">
        {props.error ? (
          <div className={errorBannerClass}>{props.error}</div>
        ) : null}
        <div className="flex justify-end gap-3">
          {showClose ? (
            <button
              type="button"
              onClick={props.onClose}
              disabled={submitting}
              className={pillGhostClass}
            >
              {translate("common.cancel")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() =>
              props.onConfirm({
                openrindDesktopHostUrl: openrindDesktopHostUrl.trim(),
                openrindDesktopToken: openrindDesktopToken.trim(),
                directory: directory.trim() ? directory.trim() : null,
                displayName: displayName.trim() ? displayName.trim() : null,
              })
            }
            disabled={!canSubmit}
            title={
              !openrindDesktopHostUrl.trim()
                ? translate("dashboard.remote_base_url_required")
                : undefined
            }
            className={pillPrimaryClass}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className={isInline ? "w-full" : modalOverlayClass}>{content}</div>
  );
}
