import type { ReactNode } from "react"
import { ROUTES } from "@/lib/routes"

/**
 * Standalone legal pages — Privacy Policy and Terms of Service. Rendered at
 * /privacy and /terms (see main.tsx) with no map, store, or app shell, so the
 * URLs are stable and cheap to link from OAuth consent screens, app-store
 * listings, and Google's OAuth verification review.
 *
 * Plain language on purpose. The substance below is grounded in what Grapevine
 * actually does — Supabase Auth, coarse geolocation, Google Calendar sync, the
 * Ask Grapevine assistant, reactions/interests, and Web Push. If a data flow
 * changes, update the matching section and bump the "Last updated" date.
 */

// One place to change the contact address and effective date. The address
// comes from VITE_CONTACT_EMAIL (web/.env.local); the fallback keeps an unset
// deployment visibly unset rather than pointing at someone else's inbox.
const CONTACT_EMAIL =
  (import.meta.env.VITE_CONTACT_EMAIL as string | undefined) ||
  "privacy@example.com"
const LAST_UPDATED = "July 22, 2026"

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <a
          href="/"
          className="font-heading text-sm font-semibold tracking-tight text-muted-foreground italic hover:text-foreground"
        >
          Grapevine
        </a>
        <h1 className="mt-6 font-heading text-3xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Last updated {LAST_UPDATED}
        </p>
        <div className="mt-10 flex flex-col gap-8 text-sm leading-relaxed text-foreground/90">
          {children}
        </div>
        <footer className="mt-16 flex gap-4 border-t border-foreground/10 pt-6 text-sm text-muted-foreground">
          <a className="hover:text-foreground" href={ROUTES.privacy}>
            Privacy
          </a>
          <a className="hover:text-foreground" href={ROUTES.terms}>
            Terms
          </a>
          <a className="hover:text-foreground" href="/">
            Back to the map
          </a>
        </footer>
      </div>
    </main>
  )
}

function Section({
  heading,
  children,
}: {
  heading: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-heading text-lg font-semibold">{heading}</h2>
      {children}
    </section>
  )
}

export function PrivacyPolicy() {
  return (
    <Shell title="Privacy Policy">
      <p>
        Grapevine is a live map of local events in San Diego. This policy
        explains what we collect, why, who we share it with, and the choices you
        have. We keep it short because we collect little.
      </p>

      <Section heading="What we collect">
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>
            <span className="font-medium">Account details.</span> When you sign
            in with Google or GitHub, we receive your name, email address, and
            profile picture from that provider so we can create and identify
            your account.
          </li>
          <li>
            <span className="font-medium">Location.</span> If you allow it, your
            browser shares your location so we can show what is near you and
            estimate when to leave for an event. Before it is stored, your
            location is rounded to a coarse grid (roughly 110 meters). We never
            store your exact position, and location is optional.
          </li>
          <li>
            <span className="font-medium">Your activity in the app.</span>{" "}
            Events you save, your reactions, and the interests you set. We use
            these to personalize what we surface and, if you opt in, to send
            reminders.
          </li>
          <li>
            <span className="font-medium">Ask Grapevine conversations.</span> If
            you use the assistant, your messages and its replies are stored
            against your account so your history is there next time. Only you
            can read your own conversations.
          </li>
          <li>
            <span className="font-medium">Notifications.</span> If you enable
            push notifications, we store the subscription your browser issues so
            we can send event reminders and the weekly digest. You can turn this
            off any time.
          </li>
        </ul>
      </Section>

      <Section heading="Google Calendar">
        <p>
          If you connect Google Calendar, we ask Google for permission to add
          and manage events on your calendar so that events you save in
          Grapevine sync automatically. We store the access token Google issues,
          encrypted, only to provide that sync. You can disconnect at any time
          from your account settings, which revokes our access.
        </p>
        <p>
          Grapevine's use and transfer of information received from Google APIs
          adheres to the{" "}
          <a
            className="text-wine underline underline-offset-2"
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noreferrer"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. We do not use Google user
          data for advertising, and we do not sell it or share it with third
          parties except as needed to provide the sync you asked for.
        </p>
      </Section>

      <Section heading="How we use it">
        <p>
          We use the information above to run the service: to show relevant
          nearby events, sync your calendar, answer your questions, send the
          reminders you opt into, and keep your account working across devices.
          We do not sell your personal information, and we do not use it for
          advertising or share it with data brokers.
        </p>
      </Section>

      <Section heading="Who processes your data">
        <p>
          These providers process data on our behalf so the app can function:
        </p>
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>
            <span className="font-medium">Supabase</span> hosts our database and
            handles sign-in.
          </li>
          <li>
            <span className="font-medium">Mapbox</span> serves the map. Loading
            the map sends your IP address and the area you are viewing to
            Mapbox.
          </li>
          <li>
            <span className="font-medium">Google and GitHub</span> handle
            sign-in, and Google provides calendar access if you connect it.
          </li>
        </ul>
        <p>
          The AI behind Ask Grapevine runs on infrastructure we control. Your
          conversations are not sent to a third-party AI provider for training
          or any other purpose.
        </p>
      </Section>

      <Section heading="How long we keep it">
        <p>
          We keep your account data while your account exists. Conversations,
          reactions, and saved events remain until you delete them or ask us to
          close your account. Coarse location is retained only as long as needed
          for departure alerts. Ask us to delete your account and we remove your
          personal data, except anything we must keep to meet legal obligations.
        </p>
      </Section>

      <Section heading="Your choices and rights">
        <p>
          You can decline location and notification permissions and still use
          the map. You can disconnect Google Calendar, clear your Ask Grapevine
          history, and sign out at any time. Depending on where you live, you
          may have the right to access, correct, delete, or export your personal
          information, and to opt out of its sale or sharing. We do not sell or
          share your personal information as those terms are defined by law. To
          exercise any right, email us at{" "}
          <a
            className="text-wine underline underline-offset-2"
            href={`mailto:${CONTACT_EMAIL}`}
          >
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </Section>

      <Section heading="Children">
        <p>
          Grapevine is not directed to children under 13, and we do not
          knowingly collect their data.
        </p>
      </Section>

      <Section heading="Changes and contact">
        <p>
          If we make material changes to this policy, we will update the date
          above and, where appropriate, notify you in the app. Questions? Reach
          us at{" "}
          <a
            className="text-wine underline underline-offset-2"
            href={`mailto:${CONTACT_EMAIL}`}
          >
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </Section>
    </Shell>
  )
}

export function TermsOfService() {
  return (
    <Shell title="Terms of Service">
      <p>
        These terms are the agreement between you and Grapevine for use of the
        app. By using Grapevine you agree to them. If you do not agree, please
        do not use the service.
      </p>

      <Section heading="The service">
        <p>
          Grapevine helps you discover local events in San Diego, save them,
          sync them to your calendar, and get reminders. Event information is
          gathered from public sources and submissions and may not always be
          accurate, complete, or current. Always confirm times, prices, and
          details with the organizer before you go.
        </p>
      </Section>

      <Section heading="Your account">
        <p>
          You sign in through Google or GitHub. You are responsible for activity
          under your account and for keeping access to your sign-in provider
          secure. You must be at least 13 years old to use Grapevine.
        </p>
      </Section>

      <Section heading="Acceptable use">
        <p>You agree not to:</p>
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>
            break the law or infringe anyone's rights while using the service;
          </li>
          <li>
            scrape, overload, probe, or disrupt the service or its
            infrastructure;
          </li>
          <li>
            attempt to access accounts, data, or systems that are not yours; or
          </li>
          <li>
            submit false event listings or misuse the Ask Grapevine assistant to
            cause harm.
          </li>
        </ul>
      </Section>

      <Section heading="Content and intellectual property">
        <p>
          Grapevine, including its design, code, and original content, belongs
          to us. Event data may belong to the organizers or sources it comes
          from. Anything you submit remains yours, but you grant us a license to
          display and use it to operate the service.
        </p>
      </Section>

      <Section heading="Third-party services">
        <p>
          Grapevine relies on services such as Google, GitHub, Supabase, and
          Mapbox, and links to third-party event pages. Your use of those
          services is governed by their own terms, and we are not responsible
          for third-party content or sites.
        </p>
      </Section>

      <Section heading="Disclaimers">
        <p>
          The service is provided "as is" and "as available," without warranties
          of any kind, to the fullest extent permitted by law. We do not
          guarantee that event information is accurate or that the service will
          be uninterrupted or error-free.
        </p>
      </Section>

      <Section heading="Limitation of liability">
        <p>
          To the fullest extent permitted by law, Grapevine is not liable for
          any indirect, incidental, or consequential damages arising from your
          use of the service, including missing an event or relying on
          inaccurate listings.
        </p>
      </Section>

      <Section heading="Changes and termination">
        <p>
          We may update these terms or change the service over time. If we make
          material changes we will update the date above. You can stop using
          Grapevine at any time, and we may suspend or end access that violates
          these terms.
        </p>
      </Section>

      <Section heading="Contact">
        <p>
          Questions about these terms? Email us at{" "}
          <a
            className="text-wine underline underline-offset-2"
            href={`mailto:${CONTACT_EMAIL}`}
          >
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </Section>
    </Shell>
  )
}
