"""Remove an account's application data without touching Google originals."""


USER_COLLECTIONS = (
    'users', 'sources', 'drafts', 'items', 'google', 'gmail-seen',
    'gmail-settings', 'calendar', 'tasks', 'chat', 'chat-pending', 'drive',
    'tasks-claims', 'chat-threads',
)


class Accounts:
    def __init__(self, store, oauth, client):
        self.store = store
        self.oauth = oauth
        self.client = client

    async def delete(self, user: str) -> dict:
        token = None
        with self.store.transaction():
            google = self.store.get('google', user, user)
            if google and google.get('tokens'):
                try:
                    tokens = self.oauth.open(google['tokens'], user)
                    candidate = tokens.get('refresh_token') or tokens.get('access_token')
                    if isinstance(candidate, str) and candidate:
                        token = candidate
                except Exception:
                    # Unreadable credentials must never preserve local personal data.
                    pass

            # Collect every target before writing, including system-owned records.
            owned = [(collection, self.store.list(collection, user))
                     for collection in USER_COLLECTIONS]
            bound = [(collection, [doc for doc in self.store.list(collection, '@system')
                                   if doc.get('userId') == user])
                     for collection in ('sessions', 'oauth')]
            for collection, documents in owned:
                for doc in documents:
                    self.store.delete(collection, doc['id'], user)
            for collection, documents in bound:
                for doc in documents:
                    self.store.delete(collection, doc['id'], '@system')

        cleanup_pending = False
        cleanup_files = getattr(self.store, 'delete_user_files', None)
        if cleanup_files is not None:
            try:
                cleanup_files(user)
            except Exception:
                # Do not log exceptions that can contain private object paths.
                cleanup_pending = True

        # All local data and sessions are gone before any awaited network request.
        if token is not None:
            try:
                await self.client.post('https://oauth2.googleapis.com/revoke',
                                       data={'token': token}, timeout=5)
            except Exception:
                # Token revocation is best effort and must not undo account deletion.
                pass
        return {'ok': True, 'cleanupPending': cleanup_pending}
