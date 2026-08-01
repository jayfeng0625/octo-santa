// Typed domain errors, for adapters that must map failures onto protocol
// error codes without parsing message strings.

export class ChannelNotFoundError extends Error {
  constructor(channelName: string) {
    super(`Channel "${channelName}" does not exist`);
    this.name = "ChannelNotFoundError";
  }
}
