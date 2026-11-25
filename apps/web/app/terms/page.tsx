import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal/LegalPage";
import { SITE } from "@/lib/site";

// Terms of Service (F37 part 1, founder 2026-11-25). Plain English; invite-only beta. To be read by
// someone who knows Indian law before the public launch.

const UPDATED = "25 November 2026";
const { operator } = SITE;

export const metadata: Metadata = {
  title: "Terms of Service",
  description: `The rules for using ${SITE.name}.`,
};

function Email() {
  return <a href={`mailto:${SITE.contactEmail}`}>{SITE.contactEmail}</a>;
}

export default function TermsPage() {
  return (
    <LegalPage
      eyebrow="Terms"
      title="Terms of Service"
      updated={UPDATED}
      intro={
        <p>
          These terms are an agreement between you and <strong>{operator.name}</strong>, {operator.city},{" "}
          {operator.state}, {operator.country}, which runs {SITE.name}. By creating an account or using{" "}
          {SITE.name}, you agree to them. Please also read our <Link href="/privacy">Privacy Policy</Link>.
        </p>
      }
    >
      <LegalSection id="the-service" title="1. The service">
        <p>
          {SITE.name} helps you turn a topic into a short explainer video with AI writing, an AI voice-over and
          animation, and to publish it to your Instagram after you approve it. {SITE.name} is currently an{" "}
          <strong>invite-only beta</strong>: features may change, and we may pause or end the beta.
        </p>
      </LegalSection>

      <LegalSection id="your-account" title="2. Your account">
        <ul>
          <li>You must be 18 or older and give a real name and email address.</li>
          <li>Keep your password private. You are responsible for what happens in your account.</li>
          <li>Tell us straight away at <Email /> if you think someone else used your account.</li>
        </ul>
      </LegalSection>

      <LegalSection id="your-content" title="3. Your content">
        <ul>
          <li>
            <strong>Your topics, storyboards and videos are yours.</strong> You give us permission to store and
            process them only to provide {SITE.name} to you: to write, record, render, store and, when you approve,
            publish them.
          </li>
          <li>
            Only enter material you have the right to use. Don&apos;t include other people&apos;s personal or
            confidential information in your topics.
          </li>
          <li>
            You are responsible for what you approve and publish, including checking that it is accurate and
            follows Instagram&apos;s rules.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="ai" title="4. AI can make mistakes">
        <p>
          Storyboards, narration, pictures and captions are created with AI and can contain mistakes, including
          wrong facts or mispronounced words. <strong>Always check before you approve.</strong> Nothing is made into
          a video or posted without your approval, and you can change or undo before approving.
        </p>
      </LegalSection>

      <LegalSection id="acceptable-use" title="5. Acceptable use">
        <p>Don&apos;t use {SITE.name} to make or publish content that:</p>
        <ul>
          <li>is illegal, hateful, harassing, sexual, violent or harmful to children;</li>
          <li>misleads people dangerously, for example false medical or financial advice;</li>
          <li>copies someone else&apos;s work without permission, or pretends to be another person.</li>
        </ul>
        <p>
          And don&apos;t try to get around the limits, break or overload the service, or access other people&apos;s
          data.
        </p>
      </LegalSection>

      <LegalSection id="limits" title="6. Fair-use limits">
        <p>
          To keep costs fair, {SITE.name} has limits, for example on videos per day, projects per day, AI requests
          per project and voice characters per month. The app shows you the limits and when they reset. We may
          change them during the beta.
        </p>
      </LegalSection>

      <LegalSection id="instagram" title="7. Instagram">
        <p>
          Publishing uses Instagram&apos;s official API and Instagram&apos;s own terms apply to your Instagram
          account. Instagram can refuse, delay or remove a post, or limit how many posts can be published in a day;
          we can&apos;t control that. You can disconnect Instagram at any time.
        </p>
      </LegalSection>

      <LegalSection id="price" title="8. Price">
        <p>The beta is free. If we ever introduce paid plans, we will tell you first; nothing is charged without your agreement.</p>
      </LegalSection>

      <LegalSection id="suspension" title="9. Suspension and ending">
        <p>
          You can stop using {SITE.name} and delete your account at any time (see{" "}
          <Link href="/privacy#delete-your-data">How to delete your data</Link>). We may suspend or close an account
          that breaks these terms or puts others at risk; where possible we will tell you why first.
        </p>
      </LegalSection>

      <LegalSection id="no-warranty" title="10. No guarantees">
        <p>
          {SITE.name} is provided &quot;as is&quot; during the beta. We work to keep it reliable and your data safe,
          but we can&apos;t promise it will always be available or error-free. Keep your own copy of videos that
          matter to you (use Download MP4).
        </p>
      </LegalSection>

      <LegalSection id="liability" title="11. Limits on our responsibility">
        <p>
          As far as the law allows, we are not responsible for indirect losses, such as lost followers, income or
          opportunities, or for content you approved and published. Nothing in these terms limits rights you have
          under Indian consumer law that can&apos;t be limited.
        </p>
      </LegalSection>

      <LegalSection id="law" title="12. Law and disputes">
        <p>
          These terms are governed by the laws of India. If there is a problem, please email us first at{" "}
          <Email /> and we will try to solve it. Otherwise, the courts of {operator.city}, {operator.state} have
          jurisdiction.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="13. Changes to these terms">
        <p>
          If we change these terms, we will update the date at the top, and for important changes tell you in the
          app or by email before they apply. If you keep using {SITE.name} after that, the new terms apply.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
