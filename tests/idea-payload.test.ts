import { CreateProjectBodySchema } from "@bytereel/db";
import { describe, expect, it } from "vitest";
import { createProjectPayload, pickedLanguageHint, type PickedChoice } from "../apps/web/lib/project/idea-payload";

// F14 review: the C2 body the Idea screen sends after a brainstorm pick (API.md C2).

const hindi: PickedChoice = { subject: "मानसून", title: "मानसून पहले केरल क्यों आता है", hook: "हर जून केरल सबसे पहले भीगता है।", language: "hi" };
const english: PickedChoice = { subject: "Indian monsoon", title: "Why the monsoon reaches Kerala first", hook: "Every June, Kerala gets wet first.", language: "en" };

describe("createProjectPayload", () => {
  it("picked idea, same language, 3–300 characters → brainstorm with the choice (and C2 accepts it)", () => {
    const body = createProjectPayload({ text: `${english.title}. ${english.hook}`, language: "en", voiceGender: "female", picked: english });
    expect(body).toEqual({ inputType: "brainstorm", text: `${english.title}. ${english.hook}`, language: "en", voiceGender: "female", brainstormChoice: { subject: english.subject, title: english.title, hook: english.hook } });
    expect(CreateProjectBodySchema.safeParse(body).success).toBe(true);
  });

  it("language chip changed after the pick → plain topic, no brainstormChoice", () => {
    const body = createProjectPayload({ text: `${hindi.title}। ${hindi.hook}`, language: "en", voiceGender: "male", picked: hindi });
    expect(body).toEqual({ inputType: "topic", text: `${hindi.title}। ${hindi.hook}`, language: "en", voiceGender: "male" });
    expect(CreateProjectBodySchema.safeParse(body).success).toBe(true);
  });

  it("edited over 300 characters → notes; no pick → topic/notes as before", () => {
    expect(createProjectPayload({ text: "x".repeat(301), language: "en", voiceGender: "female", picked: english }).inputType).toBe("notes");
    expect(createProjectPayload({ text: "How UPI works", language: "en", voiceGender: "female", picked: null })).toEqual({ inputType: "topic", text: "How UPI works", language: "en", voiceGender: "female" });
  });
});

describe("pickedLanguageHint", () => {
  it("only when the languages differ", () => {
    expect(pickedLanguageHint(null, "en")).toBeNull();
    expect(pickedLanguageHint(english, "en")).toBeNull();
    expect(pickedLanguageHint(hindi, "en")).toBe("This idea was suggested in Hindi. Brainstorm again for English ideas.");
    expect(pickedLanguageHint(english, "hinglish")).toBe("This idea was suggested in English. Brainstorm again for Hinglish ideas.");
  });
});
