// Request id ranges on one engine connection. The UI client counts up from 1; the Electron main process (which
// shares the connection for its liveness pings) counts down from MAX_REQUEST_ID. The ranges never meet, so every id
// stays unique per connection as the protocol demands.
import { MAX_REQUEST_ID } from "./generated/protocol.ts";

/** Lowest id the main-process supervisor uses for its own pings. */
export const HOST_ID_FLOOR = MAX_REQUEST_ID - 100_000_000;

/** Highest id the client hands out; a connection that reaches it must be restarted. */
export const CLIENT_MAX_ID = HOST_ID_FLOOR - 1;
