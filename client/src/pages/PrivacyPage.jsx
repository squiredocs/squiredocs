/**
 * Privacy Policy — public page served at /privacy.
 *
 * Standard privacy policy adapted to what Squire Docs actually does:
 * Google OAuth sign-in, document storage, third-party AI processing
 * (the providers in server/api/ai-providers.js — keep the provider list
 * in the AI section in sync with that file), background Google search
 * embeddings, agent/plugin token access, S3 image storage, and analytics.
 *
 * The sign-in disclosure under "Usage and log data" must likewise track what
 * feature 034 actually stores (server/auth/auth-context.js + auth-events.js):
 * IP address and user-agent recorded at signup and at each sign-in, the
 * 180-day auth-history retention, and the account-lifetime retention of the
 * most recent values. If that behavior changes, this paragraph changes with it.
 *
 * Review with legal counsel before relying on it for compliance.
 */
import LegalPage from './LegalPage';

const LAST_UPDATED = 'July 25, 2026';
const CONTACT_EMAIL = 'contact@squiredocs.com';

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" lastUpdated={LAST_UPDATED}>
      <p className="legal-intro">
        This Privacy Policy explains how 21st Harmonic LLC ("21st Harmonic,"
        "we," "us," or "our") collects, uses, and shares information when you use
        Squire Docs, our collaborative document editor, and related services (the
        "Service"). By using the Service, you agree to the practices described
        here.
      </p>

      <h2>Information We Collect</h2>

      <h3>Account information</h3>
      <p>
        You sign in with Google. When you do, we receive basic profile
        information from your Google account — your name, email address, and
        profile picture — which we use to create and manage your account. We do
        not receive your Google password.
      </p>

      <h3>Content you create</h3>
      <p>
        We store the documents you create, edit, and share, including their text,
        formatting, version history, and any images you upload. Uploaded images
        are stored in cloud object storage (Amazon S3). Document content is
        retained so that it is available to you and to the collaborators you
        choose to share it with.
      </p>

      <h3>Conversations with the AI assistant</h3>
      <p>
        When you use the in-app AI assistant or chat features, we store your
        prompts, the assistant's responses, and related conversation history so
        you can return to past conversations. See "AI Features and Third-Party AI
        Providers" below for how this content is processed.
      </p>

      <h3>API keys (Bring Your Own Key)</h3>
      <p>
        If you choose to supply your own API keys for a supported third-party
        AI provider, we store them encrypted at rest and use them only to make
        AI requests on your behalf.
      </p>

      <h3>Support requests</h3>
      <p>
        If you contact us for support, we store the message you send and your
        email address so we can respond.
      </p>

      <h3>Usage and log data</h3>
      <p>
        We automatically collect certain technical information when you use the
        Service, such as your IP address, browser and device information, the
        pages you visit, and AI usage metrics (for example, model used and token
        counts, which we use to meter usage and enforce limits). We use cookies
        and similar technologies to keep you signed in and to maintain your
        session.
      </p>
      <p>
        When you create an account, and each time you sign in, we record the IP
        address and the browser or client (user-agent) information of that
        request. We use this for security and abuse prevention — for example, to
        identify accounts created in bulk from the same source to abuse free
        usage credits. We keep this sign-in history for 180 days; the values
        from your account's creation and your most recent sign-in stay
        associated with your account for as long as it exists.
      </p>

      <h3>Analytics</h3>
      <p>
        We use Google Analytics to understand how the Service is used. Google
        Analytics collects information such as pages viewed and general usage
        patterns through cookies. You can learn more from Google's privacy
        resources and control cookies through your browser settings.
      </p>

      <h2>How We Use Information</h2>
      <ul>
        <li>To provide, operate, and maintain the Service;</li>
        <li>To authenticate you and secure your account;</li>
        <li>To store and sync your documents and make them available to collaborators you authorize;</li>
        <li>To provide AI-assisted features that you invoke;</li>
        <li>To meter AI usage and enforce usage limits;</li>
        <li>To respond to your support requests and communicate with you about the Service;</li>
        <li>To monitor, debug, and improve the Service and protect against abuse, fraud, and security threats;</li>
        <li>To comply with legal obligations.</li>
      </ul>

      <h2>AI Features and Third-Party AI Providers</h2>
      <p>
        When you use AI features, the content needed to fulfill your request —
        such as your prompts, relevant document content, and attached images — is
        sent to a third-party AI provider to generate a response. Depending on
        the model you select, that provider is currently Anthropic, Google,
        OpenAI, or Z.ai, or a model host reached through the OpenRouter gateway
        (for example Moonshot AI, Alibaba, or MiniMax). The models currently
        available, and the provider each one belongs to, are shown in the model
        picker in the app. This processing is necessary to provide the feature.
        Your use of these features is also subject to the relevant provider's
        terms and privacy policies. If you use your own API key, your requests
        are sent to the corresponding provider under your account with that
        provider.
      </p>
      <p>
        Separately from AI features you invoke directly, we use Google's
        embedding API to power in-app search: when a document is created or
        edited, its text is sent to Google to generate search embeddings, which
        we store as part of the search index. Some background processing that
        supports AI features, such as summarizing long chat histories, may also
        use a different provider than the model you selected.
      </p>
      <p>
        We do not train AI models of our own on your content. The third-party
        providers described above process requests under their own terms, which
        govern whether and how they may use content submitted through their
        APIs.
      </p>

      <h2>Agent and Plugin Integrations</h2>
      <p>
        You can connect external AI agents and tools — such as Claude, Cursor,
        or Kiro — to your account through OAuth or API access tokens. When you
        authorize an integration, it can read and edit the documents your
        account can access, and document content you direct it to work with
        flows to that agent and to the AI service that powers it, under that
        service's own terms. You can review and revoke an integration's access
        tokens at any time in the app's settings.
      </p>

      <h2>How We Share Information</h2>
      <p>
        <strong>We do not sell your personal information.</strong> We share
        information only as described here:
      </p>
      <ul>
        <li>
          <strong>With collaborators:</strong> Documents and related activity are
          visible to the people you share them with, according to the access
          (Owner, Editor, or Viewer) you grant.
        </li>
        <li>
          <strong>With service providers:</strong> We use third parties to host
          and operate the Service — including cloud hosting and database storage,
          Amazon S3 for image storage, email delivery, and the AI providers
          described above. They may process information only on our behalf to
          provide their services.
        </li>
        <li>
          <strong>For legal reasons:</strong> We may disclose information if
          required by law or to protect the rights, safety, and security of our
          users, the public, or 21st Harmonic.
        </li>
        <li>
          <strong>Business transfers:</strong> If 21st Harmonic is involved in a
          merger, acquisition, or sale of assets, information may be transferred
          as part of that transaction.
        </li>
      </ul>

      <h2>Data Retention</h2>
      <p>
        We retain your information for as long as your account is active or as
        needed to provide the Service. We retain encrypted backups of the
        database for a limited period for disaster recovery. When you delete a
        document it is removed from the active Service, and when you ask us to
        delete your account we will delete or anonymize your personal information,
        except where we are required to retain it for legal or legitimate
        business purposes. Sign-in history (the IP address and user-agent of each
        signup and sign-in, described above) is deleted automatically after 180
        days, and all of it is deleted with your account.
      </p>

      <h2>Security</h2>
      <p>
        We use technical and organizational measures designed to protect your
        information, including encrypted connections, access controls scoped to
        your account, and encryption at rest for stored API keys. No method of
        transmission or storage is completely secure, however, and we cannot
        guarantee absolute security.
      </p>

      <h2>Your Rights and Choices</h2>
      <p>
        Depending on where you live, you may have rights to access, correct,
        export, or delete your personal information, or to object to or restrict
        certain processing. You can edit or delete your documents at any time
        within the Service. To exercise other rights or to request account
        deletion, contact us at{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>

      <h2>Children's Privacy</h2>
      <p>
        The Service is not directed to children under 13 (or the minimum age
        required in your jurisdiction), and we do not knowingly collect personal
        information from them. If you believe a child has provided us personal
        information, please contact us so we can remove it.
      </p>

      <h2>International Users</h2>
      <p>
        We operate the Service from the United States, and your information may be
        processed and stored in the United States and other countries where we or
        our service providers operate. These countries may have data protection
        laws that differ from those in your country.
      </p>

      <h2>Changes to This Policy</h2>
      <p>
        We may update this Privacy Policy from time to time. When we do, we will
        revise the "Last updated" date above, and significant changes may be
        communicated through the Service. Your continued use of the Service after
        an update means you accept the revised policy.
      </p>

      <h2>Contact Us</h2>
      <p>
        If you have questions about this Privacy Policy or our data practices,
        contact us at <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    </LegalPage>
  );
}
