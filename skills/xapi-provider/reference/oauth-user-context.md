# OAuth user-context endpoints

Some upstream operations act as the end user, such as posting to a social
account or reading private messages. An application-level HEADER, BEARER, or
QUERY secret is insufficient for those operations.

The provider CLI can carry `userOAuthProviderId` on an endpoint contract, but
the backend permits that field only for authorized providers. Obtain the
correct provider ID through the platform's approved OAuth setup; never guess an
ID or substitute a provider credential.

```json
{
  "endpoints": [
    {
      "id": "existing-endpoint-id",
      "userOAuthProviderId": "approved-provider-uuid"
    }
  ]
}
```

```bash
npx xapi-to provider version update \
  <service-id> <version-id> --file ./oauth.patch.json
```

If the command reports that only platform administrators can configure OAuth,
stop and tell the user the service contract is ready but the endpoint needs an
administrator to bind the approved OAuth provider. Do not remove the
user-context requirement to make review pass.
