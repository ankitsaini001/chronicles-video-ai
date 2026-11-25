import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal/LegalPage";
import { SITE } from "@/lib/site";

// Privacy Policy (F37 part 1, founder 2026-11-25). Plain English, honest about the services we use.
// "#delete-your-data" is the Data Deletion Instructions link for the Meta app settings until the
// automatic deletion callback (F37 part 2) exists. To be read by someone who knows India's DPDP
// Act before the public launch.

const UPDATED = "25 November 2026";
const { operator } = SITE;
const place = `${operator.city}, ${operator.state}, ${operator.country}`;

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: `How ${SITE.name} collects, uses, keeps and deletes your data.`,
};

function Email() {
  return <a href={`mailto:${SITE.contactEmail}`}>{SITE.contactEmail}</a>;
}

export default function PrivacyPage() {
  return (
    <LegalPage
      eyebrow="Privacy"
      title="Privacy Policy"
      updated={UPDATED}
      intro={
        <p>
          {SITE.name} turns your topic into a short explainer video and, only when you approve, publishes it to your
          Instagram. This page explains what data we collect, why, who helps us process it, how long we keep it and
          how to delete it. We don&apos;t sell your data and we don&apos;t show ads.
        </p>
      }
    >
      <LegalSection id="who-we-are" title="1. Who we are">
        <p>
          {SITE.name} is run by <strong>{operator.name}</strong>, {place} (&quot;we&quot;, &quot;us&quot;). For
          any privacy question, request or complaint, email <Email />. This address also reaches our grievance
          contact under India&apos;s Digital Personal Data Protection Act, 2023. We aim to reply within 7 days.
        </p>
      </LegalSection>

      <LegalSection id="what-we-collect" title="2. What we collect">
        <ul>
          <li>
            <strong>Your account:</strong> your name and email address. Your password is stored only in a scrambled
            form (hashed); nobody, including us, can read it.
          </li>
          <li>
            <strong>What you create:</strong> the topics and notes you type, your storyboards and their versions,
            the changes you ask for, the AI narration audio, your caption edits and your finished videos.
          </li>
          <li>
            <strong>Your Instagram connection</strong> (only if you connect it): your Instagram username, account id,
            account type and profile picture link, and the access key Instagram gives us. The key is stored
            encrypted and is never shown to anyone.
          </li>
          <li>
            <strong>Your posts:</strong> the caption you approved, when you approved it, and the link to the post
            after it is published.
          </li>
          <li>
            <strong>Usage records:</strong> how many videos and AI requests you used (for the daily limits), and
            technical logs of errors. These logs don&apos;t contain your passwords or access keys.
          </li>
          <li>
            <strong>One login cookie</strong> that keeps you signed in. We use no advertising or tracking cookies.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="why" title="3. Why we use it">
        <ul>
          <li>To create your account and keep you signed in.</li>
          <li>To write the storyboard, record the narration, make the video and suggest a caption.</li>
          <li>To publish to your Instagram, only after you tick the approval for that exact video and caption.</li>
          <li>To apply fair-use limits, prevent misuse and fix problems.</li>
          <li>To answer you when you contact us.</li>
        </ul>
        <p>
          We use your data only for these purposes, based on your consent when you sign up and use {SITE.name}. You
          can withdraw your consent at any time by deleting your account (section 7).
        </p>
      </LegalSection>

      <LegalSection id="who-helps-us" title="4. Services that process data for us">
        <p>We share only what each service needs to do its job:</p>
        <ul>
          <li>
            <strong>Google Gemini</strong> (AI writing): your topic, storyboard text and change requests, to write
            storyboards and captions. <strong>Please note:</strong> during this testing phase we use Gemini&apos;s
            free tier, and Google&apos;s terms allow it to use content sent on the free tier to improve its
            products. Don&apos;t include personal or confidential information in your topics. We will move to a
            paid tier, where Google doesn&apos;t use the content this way, before inviting beta users, and update
            this page.
          </li>
          <li>
            <strong>ElevenLabs</strong> (AI voice): the narration text, to record the voice-over.
          </li>
          <li>
            <strong>Cloudflare R2</strong> (file storage): your narration audio, videos and thumbnails, in a private
            store.
          </li>
          <li>
            <strong>MongoDB Atlas</strong> (database): your account, projects and the records above.
          </li>
          <li>
            <strong>Inngest</strong> (background tasks): short task messages with ids, not your content.
          </li>
          <li>
            <strong>Meta / Instagram</strong>: when you connect, you log in on Instagram&apos;s own page; when you
            publish, Instagram receives the video and caption you approved.
          </li>
          <li>
            <strong>Our hosting provider</strong> runs the website itself.
          </li>
        </ul>
        <p>
          Some of these services store data outside India. They process it on our instructions and under their own
          security and privacy terms. We don&apos;t sell or rent your data to anyone.
        </p>
      </LegalSection>

      <LegalSection id="instagram" title="5. Your Instagram">
        <ul>
          <li>We ask Instagram only for permission to read your basic profile and to publish content.</li>
          <li>
            Nothing is posted without your approval of that exact video, caption and account. If you change any of
            them, you approve again.
          </li>
          <li>
            You can disconnect at any time on the Publish step (and in Settings, once available). Disconnecting
            deletes the access key straight away. You can also remove {SITE.name} in Instagram under Settings →
            Website permissions → Apps and websites.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="how-long" title="6. How long we keep data">
        <ul>
          <li>Your account and your projects: while your account is open.</li>
          <li>Your Instagram access key: until you disconnect, or about 60 days after it was last renewed.</li>
          <li>
            After you ask to delete your account: everything is erased <strong>30 days</strong> later (section 7).
          </li>
          <li>
            Anonymous usage statistics (for example &quot;a video was made on this day&quot;), with nothing that
            identifies you, may be kept after that.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="delete-your-data" title="7. How to delete your data">
        <p>
          <strong>To delete your account and all your data</strong>, email <Email /> from the email address of your
          account with the subject &quot;Delete my account&quot;. (A Delete account button in Settings is coming.)
        </p>
        <ul>
          <li>
            Straight away, you are signed out everywhere, your account is locked, any scheduled post is cancelled,
            and your Instagram access key and connection are deleted.
          </li>
          <li>
            For <strong>30 days</strong> we keep the rest, so that a deletion asked by mistake can be undone. Email
            us within those 30 days to restore your account.
          </li>
          <li>
            After 30 days, your account, projects, storyboards, audio, videos and records are erased. Only anonymous
            usage statistics remain.
          </li>
          <li>Posts already published on Instagram stay there; delete them in the Instagram app if you want.</li>
        </ul>
        <p>
          <strong>To delete only your Instagram data</strong>, disconnect Instagram on the Publish step, or remove{" "}
          {SITE.name} in Instagram under Settings → Website permissions → Apps and websites.
        </p>
      </LegalSection>

      <LegalSection id="your-rights" title="8. Your rights">
        <p>
          You can ask us to see the personal data we hold about you, to correct it, or to delete it, and you can
          withdraw your consent. You can also name someone to act for you if you can&apos;t. Email <Email />. If
          you&apos;re not satisfied with our reply, you can complain to the Data Protection Board of India.
        </p>
      </LegalSection>

      <LegalSection id="security" title="9. Security">
        <p>
          Passwords are hashed, Instagram access keys are encrypted, files are stored privately, and every page and
          request is checked so you only ever see your own data. No system is perfectly secure; if we learn of a
          breach that affects you, we will tell you and the authorities as the law requires.
        </p>
      </LegalSection>

      <LegalSection id="age" title="10. Age">
        <p>
          {SITE.name} is for people aged <strong>18 or older</strong>. We don&apos;t knowingly collect data from
          children. If you believe a child has signed up, email us and we will delete the account.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="11. Changes to this policy">
        <p>
          If we change this policy, we will update the date at the top, and for important changes tell you in the
          app or by email before they apply. See also our <Link href="/terms">Terms of Service</Link>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
