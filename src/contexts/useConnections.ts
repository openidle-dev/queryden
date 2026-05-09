import { useContext } from "react";
import { ConnectionContext } from "./ConnectionContext";

export function useConnections() {
  const context = useContext(ConnectionContext);
  if (!context) {
    throw new Error("useConnections must be used within ConnectionProvider");
  }
  return context;
}
