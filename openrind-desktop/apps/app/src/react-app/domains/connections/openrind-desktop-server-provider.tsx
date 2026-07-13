/** @jsxImportSource react */
import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { OpenrindDesktopServerStore } from "./openrind-desktop-server-store";

const OpenrindDesktopServerContext = createContext<OpenrindDesktopServerStore | null>(null);

export function OpenrindDesktopServerProvider(props: {
  store: OpenrindDesktopServerStore;
  children: ReactNode;
}) {
  return (
    <OpenrindDesktopServerContext.Provider value={props.store}>
      {props.children}
    </OpenrindDesktopServerContext.Provider>
  );
}

export function useOpenrindDesktopServer() {
  const store = useContext(OpenrindDesktopServerContext);
  if (!store) {
    throw new Error("useOpenrindDesktopServer must be used within an OpenrindDesktopServerProvider");
  }

  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return store;
}
