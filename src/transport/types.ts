export interface Transport {
  send(message: Message): void;
  close(): Promise<void>;

  onMessage(listener: (message: Message) => void): void;
}
