// Peer books (issue #262). A freed child stops being a record in its parent's
// registry and becomes a peer with an address: its child id. Each side of a
// pair keeps one file on its own machine, named after its own address, that
// lists the addresses it may reach and the token each pair shares. Nothing
// lists every agent: a book holds only what its owner was given, so no call
// can enumerate another agent's peers.
//
// The token is the first authentication of an address. The daemon that holds
// the target's book checks that a message from an address carries the token
// that book keeps for it, the same shape as the sealed relay of issue #209.
// It does not stop a process of the same user that reads the book files or
// claims a child id on the daemon socket, because the daemon still takes an
// adapter's identity on trust.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bellwetherHome, slug } from './paths.ts';
import { LOCAL_HOST } from './machine.ts';
import type { ChildBrief, ParentRecord } from './types.ts';

export const PEER_SCHEMA = 1;

/** One address a book's owner may reach. */
export interface PeerEntry {
  /** The other party's address: a child id, or a parent session's registry id when it has no child id. */
  address: string;
  /** What the other party was called when the pair formed. */
  name: string;
  /** The pair's shared secret. Both books hold the same value. */
  token: string;
  /** When the pair formed. */
  since: string;
  /** What the other party is to this book's owner. */
  relation: 'former-parent' | 'freed-child';
  /**
   * Where the other party runs, as this machine names it: `local`, or a saved
   * herdr machine. A freed child's machine leaves it out for a former parent
   * on another machine, because it never dials that machine.
   */
  host?: string;
  /**
   * For a former parent: the registry id whose daemon reads this message. On
   * another machine, it is also the id that daemon subscribes to in this
   * machine's relay outbox.
   */
  registryId?: string;
  /** For a freed child: its harness kind, which names it in an event. */
  kind?: string;
}

/** What a freed agent knows of its own freeing. */
export interface FreedSelf {
  at: string;
  /** The address of the session that freed it. */
  by: string;
  byName: string;
  reason?: string;
  name: string;
  kind: string;
  cwd?: string;
  /** The briefs its former parent held, which go with it. */
  briefs?: ChildBrief[];
}

export interface PeerBook {
  schema: number;
  /** The owner's own address. */
  address: string;
  name: string;
  /** Set on a freed agent's book. */
  freed?: FreedSelf;
  peers: PeerEntry[];
  updatedAt: string;
}

export function peersDir(): string {
  return path.join(bellwetherHome(), 'peers');
}

export function peerBookPath(address: string): string {
  return path.join(peersDir(), `${slug(address)}.json`);
}

/** The address a parent session goes by: the child id it has under its own parent, or else its registry id. */
export function sessionAddress(record: Pick<ParentRecord, 'id' | 'childId'>, childId?: string): string {
  return childId ?? record.childId ?? record.id;
}

export function newPeerToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function readPeerBook(address: string): PeerBook | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(peerBookPath(address), 'utf8')) as Partial<PeerBook>;
    if (typeof parsed.address !== 'string' || !Array.isArray(parsed.peers)) return undefined;
    return { schema: parsed.schema ?? PEER_SCHEMA, address: parsed.address, name: parsed.name ?? parsed.address, peers: parsed.peers, updatedAt: parsed.updatedAt ?? '', ...(parsed.freed ? { freed: parsed.freed } : {}) };
  } catch {
    return undefined;
  }
}

/** Write atomically with mode 0600: the file holds tokens. */
export function savePeerBook(book: PeerBook): PeerBook {
  const target = peerBookPath(book.address);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  book.updatedAt = new Date().toISOString();
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(book, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, target);
  return book;
}

/** Add or replace one entry in an owner's book, creating the book when it has none. */
export function addPeer(owner: { address: string; name: string }, entry: PeerEntry, freed?: FreedSelf): PeerBook {
  const book = readPeerBook(owner.address) ?? { schema: PEER_SCHEMA, address: owner.address, name: owner.name, peers: [], updatedAt: '' };
  book.peers = [...book.peers.filter((peer) => peer.address !== entry.address), entry];
  if (freed) book.freed = freed;
  return savePeerBook(book);
}

/** The freeing a session's child id went through, when its book on this machine records one. */
export function freedOf(childId: string | undefined): PeerBook | undefined {
  if (!childId) return undefined;
  const book = readPeerBook(childId);
  return book?.freed ? book : undefined;
}

/** The refusal a freed agent gets for a call that only a child makes. */
export function freedRefusal(tool: string, book: PeerBook): string {
  const freed = book.freed;
  const by = book.peers.find((peer) => peer.relation === 'former-parent');
  const reach = by ? ` Reach ${by.name} with peer_send to ${by.address}.` : '';
  return `${tool} is not yours to call: ${book.name} was freed by ${freed?.byName ?? 'its parent'} at ${freed?.at ?? 'an unknown time'}, so no parent takes its reports, grants its depth or retires it.${reach}`;
}

/** The entry an owner's book keeps for an address, or for a name only one entry carries. */
export function findPeer(book: PeerBook | undefined, to: string): PeerEntry | undefined {
  if (!book) return undefined;
  const byAddress = book.peers.find((peer) => peer.address === to);
  if (byAddress) return byAddress;
  const named = book.peers.filter((peer) => peer.name === to);
  return named.length === 1 ? named[0] : undefined;
}

/** The refusal for an address the caller does not hold, naming only the caller's own contacts. */
export function unknownPeer(book: PeerBook | undefined, to: string): string {
  if (!book?.peers.length) return `You hold no address "${to}". You hold no peer addresses: an address comes only from a freeing, which gives a parent and its freed child each other's.`;
  const contacts = book.peers.map((peer) => `${peer.name} (${peer.address})`).join(', ');
  return `You hold no address "${to}". An address comes only from the party that holds it, and your contacts: ${contacts}.`;
}

/** Whether two tokens match, in time that does not depend on where they differ. */
export function tokensMatch(given: string, kept: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(kept, 'utf8');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

/** A peer message the target's daemon would not take, with why. */
export class PeerRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeerRefused';
  }
}

/**
 * Check, on the daemon that holds the target's book, that a message from an
 * address carries the token that book keeps for it. Returns the entry the
 * target keeps for the sender.
 */
export function verifyPeer(to: string, from: string, token: string): PeerEntry {
  const book = readPeerBook(to);
  if (!book) throw new PeerRefused(`this machine holds no peer record for ${to}`);
  const entry = book.peers.find((peer) => peer.address === from);
  if (!entry) throw new PeerRefused(`${to} holds no address ${from}`);
  if (!tokensMatch(token, entry.token)) throw new PeerRefused(`the token for ${from} does not match the one ${to}'s record keeps`);
  return entry;
}

/** Every peer book on this machine, for doctor. */
export function listPeerBooks(): PeerBook[] {
  let files: string[];
  try {
    files = fs.readdirSync(peersDir());
  } catch {
    return [];
  }
  return files.filter((file) => file.endsWith('.json')).flatMap((file) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(peersDir(), file), 'utf8')) as PeerBook;
      return typeof parsed.address === 'string' && Array.isArray(parsed.peers) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Doctor's lines for freeing on this machine: one for each child a session
 * here freed, and one for each freed agent whose record is here. Each names
 * only the owner's own peers, never a count of anyone else's.
 */
export function peerDoctorLines(books: readonly PeerBook[] = listPeerBooks()): string[] {
  const lines: string[] = [];
  for (const book of books) {
    for (const peer of book.peers) {
      if (peer.relation !== 'freed-child') continue;
      const where = peer.host && peer.host !== LOCAL_HOST ? ` on machine ${peer.host}` : '';
      lines.push(`ok    ${book.address} freed ${peer.name} (${peer.address})${where} at ${peer.since}; it is a peer, reached with peer_send`);
    }
    if (book.freed) {
      const contacts = book.peers.length === 1 ? '1 contact' : `${book.peers.length} contacts`;
      lines.push(`ok    ${book.name} (${book.address}) is a freed agent, freed by ${book.freed.byName} (${book.freed.by}) at ${book.freed.at}; ${contacts}`);
    }
  }
  return lines;
}
