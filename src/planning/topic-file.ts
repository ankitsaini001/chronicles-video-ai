import type { Source } from "../contracts";

/**
 * A topic file (examples/*.md): a Markdown note written by the creator. The first "# " heading is
 * the topic title; the whole file is passed to the planner as source notes, and stored in the
 * plan's `sources` by application code (the model never writes sources).
 */
export interface TopicFile {
  title: string;
  content: string;
  /** Display name for the source, e.g. "examples/water-cycle.md". Never an absolute path. */
  sourceName: string;
}

export const MAX_TOPIC_FILE_CHARS = 20_000;
const MAX_TITLE_CHARS = 200;

export class TopicFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TopicFileError";
  }
}

export function parseTopicFile(content: string, sourceName: string): TopicFile {
  const text = content.replace(/\r\n/g, "\n").trim();
  if (!text) throw new TopicFileError(`${sourceName} is empty`);
  if (text.length > MAX_TOPIC_FILE_CHARS) {
    throw new TopicFileError(`${sourceName} is ${text.length} characters; the limit is ${MAX_TOPIC_FILE_CHARS}`);
  }
  const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  if (!heading) throw new TopicFileError(`${sourceName} needs a "# Title" heading line naming the topic`);
  return { title: heading.slice(0, MAX_TITLE_CHARS), content: text, sourceName };
}

/** The plan's `sources` entry for a topic file (assigned by code, with a stable ID). */
export function topicSources(topic: TopicFile): Source[] {
  return [{ id: "topic-notes", title: `Topic file: ${topic.sourceName}`, notes: topic.content }];
}
