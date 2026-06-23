/**
 * Terms of Service — public page served at /terms.
 *
 * Standard terms of service adapted to Squire Docs (Google sign-in,
 * user-owned documents, AI features, and BYOK). Squire Docs is operated by
 * 21st Harmonic LLC; governing law is Oregon, United States. Review with legal
 * counsel before relying on it.
 */
import LegalPage from './LegalPage';

const LAST_UPDATED = 'June 23, 2026';
const CONTACT_EMAIL = 'contact@squiredocs.com';

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" lastUpdated={LAST_UPDATED}>
      <p className="legal-intro">
        These Terms of Service ("Terms") govern your access to and use of Squire
        Docs (the "Service"), operated by 21st Harmonic LLC ("21st Harmonic,"
        "we," "us," or "our"). By accessing or using the Service, you agree to be
        bound by these Terms. If you do not agree, do not use the Service.
      </p>

      <h2>1. Eligibility and Accounts</h2>
      <p>
        You must be at least 13 years old (or the minimum age of digital consent
        in your jurisdiction) to use the Service. You access the Service by
        signing in with a Google account, and you are responsible for maintaining
        the security of that account and for all activity that occurs under it.
        Notify us promptly of any unauthorized use.
      </p>

      <h2>2. The Service</h2>
      <p>
        Squire Docs is a collaborative document editor with built-in AI
        assistance. We may add, change, or discontinue features at any time. We
        strive to keep the Service available but do not guarantee uninterrupted
        or error-free operation.
      </p>

      <h2>3. Your Content</h2>
      <p>
        You retain ownership of the documents and other content you create or
        upload ("Your Content"). You grant us a limited, worldwide,
        non-exclusive, royalty-free license to host, store, reproduce, modify
        (for example, to format or generate diffs), transmit, and display Your
        Content solely as needed to operate and provide the Service to you and the
        collaborators you authorize. This license ends when you delete Your
        Content or close your account, except for content retained in backups for
        a limited period or shared with collaborators who retain copies.
      </p>
      <p>
        You are responsible for Your Content and represent that you have the
        rights necessary to use it with the Service and to share it with the
        collaborators you choose.
      </p>

      <h2>4. Acceptable Use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Use the Service in violation of any applicable law or regulation;</li>
        <li>Upload or share content that is unlawful, infringing, or violates others' rights;</li>
        <li>Attempt to gain unauthorized access to the Service, other users' accounts, or our systems;</li>
        <li>Interfere with or disrupt the integrity or performance of the Service, including by circumventing usage limits or the AI execution sandbox;</li>
        <li>Use the Service to develop a competing product, or to scrape or harvest data without authorization;</li>
        <li>Transmit malware or otherwise misuse the Service.</li>
      </ul>

      <h2>5. AI Features</h2>
      <p>
        The Service offers AI-assisted features powered by third-party providers
        (currently Anthropic, Google, and OpenAI). To provide these features, the
        content needed for your request is sent to those providers. AI output may
        be inaccurate, incomplete, or otherwise unsuitable — you are responsible
        for reviewing it before relying on it, and it does not constitute
        professional advice. Your use of AI features is also subject to the
        applicable providers' terms.
      </p>

      <h2>6. Bring Your Own Key</h2>
      <p>
        You may optionally provide your own third-party AI provider API keys. If
        you do, you are responsible for your use of those keys and for any costs,
        usage limits, and terms imposed by the provider. We store your keys
        encrypted and use them only to make AI requests on your behalf.
      </p>

      <h2>7. Usage Limits</h2>
      <p>
        The Service may include usage allowances, such as a monthly AI credit
        allowance. We may set, change, or enforce these limits at our discretion,
        and requests that exceed them may be declined.
      </p>

      <h2>8. Intellectual Property</h2>
      <p>
        The Service itself — including its software, design, and trademarks — is
        owned by 21st Harmonic and its licensors and is protected by intellectual
        property laws. These Terms do not grant you any right in the Service other
        than the limited right to use it as permitted here.
      </p>

      <h2>9. Termination</h2>
      <p>
        You may stop using the Service and request deletion of your account at any
        time. We may suspend or terminate your access if you violate these Terms
        or if we discontinue the Service. Provisions that by their nature should
        survive termination — including ownership, disclaimers, limitation of
        liability, and indemnification — will survive.
      </p>

      <h2>10. Disclaimers</h2>
      <p>
        The Service is provided "as is" and "as available," without warranties of
        any kind, whether express or implied, including warranties of
        merchantability, fitness for a particular purpose, and non-infringement.
        We do not warrant that the Service will be uninterrupted, secure, or
        error-free, or that any content (including AI output) will be accurate or
        reliable.
      </p>

      <h2>11. Limitation of Liability</h2>
      <p>
        To the fullest extent permitted by law, 21st Harmonic will not be liable
        for any indirect, incidental, special, consequential, or punitive
        damages, or for any loss of data, profits, or goodwill, arising
        out of or related to your use of the Service. Our total liability for any
        claim relating to the Service will not exceed the greater of the amount
        you paid us in the twelve months before the claim or USD $100.
      </p>

      <h2>12. Indemnification</h2>
      <p>
        You agree to indemnify and hold harmless 21st Harmonic from any claims,
        damages, liabilities, and expenses arising out of Your Content, your use
        of the Service, or your violation of these Terms or applicable law.
      </p>

      <h2>13. Governing Law</h2>
      <p>
        These Terms are governed by the laws of the State of Oregon, United
        States, without regard to its conflict-of-laws rules. You agree to the
        exclusive jurisdiction of the state and federal courts located in Oregon
        for any dispute that is not subject to arbitration or small-claims
        resolution.
      </p>

      <h2>14. Changes to These Terms</h2>
      <p>
        We may update these Terms from time to time. When we do, we will revise
        the "Last updated" date above, and significant changes may be communicated
        through the Service. Your continued use of the Service after an update
        means you accept the revised Terms.
      </p>

      <h2>15. Contact Us</h2>
      <p>
        If you have questions about these Terms, contact us at{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    </LegalPage>
  );
}
