/** @jsxImportSource react */
import { useEffect } from "react";

import { ensureWorkspaceSessionSync, trackWorkspaceSessionSync } from "./session-sync";

type ReactSessionRuntimeProps = {
  workspaceId: string;
  sessionId: string | null;
  opencodeBaseUrl: string;
  openrindDesktopToken: string;
};

export function ReactSessionRuntime(props: ReactSessionRuntimeProps) {
  useEffect(() => {
    return ensureWorkspaceSessionSync({
      workspaceId: props.workspaceId,
      baseUrl: props.opencodeBaseUrl,
      openrindDesktopToken: props.openrindDesktopToken,
    });
  }, [props.workspaceId, props.opencodeBaseUrl, props.openrindDesktopToken]);

  useEffect(() => {
    return trackWorkspaceSessionSync(
      {
        workspaceId: props.workspaceId,
        baseUrl: props.opencodeBaseUrl,
        openrindDesktopToken: props.openrindDesktopToken,
      },
      props.sessionId,
    );
  }, [props.workspaceId, props.sessionId, props.opencodeBaseUrl, props.openrindDesktopToken]);

  return null;
}
