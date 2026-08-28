# WhatsApp single-send canary

This command is intentionally manual and must only target an explicitly approved test number:

```powershell
npm run whatsapp:canary -- --confirm-single-send +<approved-test-number>
```

It starts only the whatsapp-web.js runtime and Prisma dependency, resolves the provider canonical recipient, sends one fixed neutral message, and waits up to 30 seconds for `message_create`/ACK. It does not load campaign or automation modules. Lists, multiple recipients, missing confirmation, unresolved recipients, missing submission, and missing/error ACK return a non-zero exit code.

Output contains only a recipient hash, domains, generation, provider-ID presence and ACK. Do not run this command during development or against production without separate approval.
