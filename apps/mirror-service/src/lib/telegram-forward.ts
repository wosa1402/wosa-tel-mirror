import { Api, TelegramClient } from "telegram";
import { generateRandomBigInt } from "telegram/Helpers";
import { toBigIntOrNull } from "./bigint";
import { readProp } from "./object-props";

function collectNewMessagesFromUpdatesResult(result: unknown): Api.Message[] {
  const updates: unknown[] = [];
  if (result instanceof Api.UpdateShort) {
    updates.push(result.update);
  } else if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
    updates.push(...result.updates);
  } else {
    return [];
  }

  const map = new Map<number, Api.Message>();
  for (const update of updates) {
    if (
      update instanceof Api.UpdateNewChannelMessage ||
      update instanceof Api.UpdateNewMessage ||
      update instanceof Api.UpdateNewScheduledMessage
    ) {
      const message = readProp(update, "message");
      if (message instanceof Api.Message && message.id) {
        map.set(message.id, message);
      }
    }
  }

  return [...map.values()].sort((a, b) => a.id - b.id);
}

function collectMessageIdsByRandomIdFromUpdatesResult(result: unknown): Map<string, number> {
  const updates: unknown[] = [];
  if (result instanceof Api.UpdateShort) {
    updates.push(result.update);
  } else if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
    updates.push(...result.updates);
  } else {
    return new Map();
  }

  const map = new Map<string, number>();
  for (const update of updates) {
    if (!(update instanceof Api.UpdateMessageID)) continue;
    const randomId = toBigIntOrNull(readProp(update, "randomId"));
    if (!randomId) continue;
    if (!update.id) continue;
    map.set(randomId.toString(), update.id);
  }

  return map;
}

export async function forwardMessagesAsCopy(
  client: TelegramClient,
  {
    fromPeer,
    toPeer,
    messageIds,
  }: {
    fromPeer: unknown;
    toPeer: unknown;
    messageIds: number[];
  },
): Promise<(Api.Message | undefined)[]> {
  type InputEntityArg = Parameters<TelegramClient["getInputEntity"]>[0];
  const fromInput = await client.getInputEntity(fromPeer as InputEntityArg);
  const toInput = await client.getInputEntity(toPeer as InputEntityArg);

  const randomIds = messageIds.map(() => generateRandomBigInt());
  const request = new Api.messages.ForwardMessages({
    fromPeer: fromInput as Api.TypeInputPeer,
    toPeer: toInput as Api.TypeInputPeer,
    id: messageIds,
    randomId: randomIds,
    dropAuthor: true,
  });

  const result = await client.invoke(request);
  const recovered = collectNewMessagesFromUpdatesResult(result);
  const recoveredById = new Map<number, Api.Message>();
  for (const msg of recovered) recoveredById.set(msg.id, msg);

  const idsByRandomId = collectMessageIdsByRandomIdFromUpdatesResult(result);

  const fallback = (() => {
    if (recovered.length) {
      if (recovered.length !== messageIds.length) {
        console.warn(`ForwardMessages recovered ${recovered.length}/${messageIds.length} message(s) from updates; mapping may be approximate.`);
      }
      const sliced = recovered.length > messageIds.length ? recovered.slice(recovered.length - messageIds.length) : recovered;
      return messageIds.map((_, idx) => sliced[idx]);
    }

    const parsed = (client as unknown as { _getResponseMessage: (req: unknown, res: unknown, entity: unknown) => unknown })._getResponseMessage(
      request,
      result,
      toInput,
    );
    if (Array.isArray(parsed)) return parsed.map((m) => (m instanceof Api.Message ? m : undefined));
    if (parsed instanceof Api.Message) return [parsed];
    return messageIds.map(() => undefined);
  })();

  if (!idsByRandomId.size) return fallback;

  const mapped = messageIds.map((_, idx) => {
    const id = idsByRandomId.get(randomIds[idx]?.toString() ?? "");
    if (!id) return undefined;
    return recoveredById.get(id) ?? ({ id } as unknown as Api.Message);
  });

  if (!mapped.some(Boolean)) return fallback;
  return messageIds.map((_, idx) => mapped[idx] ?? fallback[idx]);
}
