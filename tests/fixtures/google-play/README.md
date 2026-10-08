# Google Play Developer API responses

What `purchases.subscriptionsv2.get` and `purchases.products.get` return, used in place of Google by
`tests/store-purchases.test.js` (#272).

**These were not captured from Google.** There are no Play credentials where this was written, so
each file is written field for field from Google's published reference, read on Oct 8, 2026:

- [SubscriptionPurchaseV2](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2)
- [ProductPurchase](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products)

The account and journey values (`obfuscatedExternalAccountId`, `obfuscatedExternalProfileId`) read
`set-by-test`: each test puts in the values its own database issued. Every other value is
synthetic. Once the service account exists (docs/STORE_PURCHASES.md), replacing these with real
responses from a licence tester's purchase, with the identifiers swapped out, is worth doing.
