# Assumptions

These a Business logic related assumptions. For code conventions check constitution.md

**Scope.** One platform is worked through: Telegram. Platforms differ too much in how posts are addressed and how comments are fetched and answered to share endpoints, so each gets its own API namespace and version, here `/telegram/v1`. Out of scope: Telegram stories; post search, though it belongs near here; replies carrying anything but text, since media widens the research surface even if it is only a base64 field; and the 401, 403 and 429 responses.

**Access.** The API is internal: callers present a service-level JWT (debatable, could be simplified), and nothing checks that a caller owns the data it touches; the consumer does. Telegram credentials never reach this service. The service that authenticates users also keeps each account's MTProto session, and the [Telegram library](#telegram-library) is the only way this one uses it.

**Ids.** Every id issued here is a UUIDv7 assigned by the database on insert, so one clock orders them, inserts append to the primary key index, and the listings can [page by id](#listing-comments). Pagination is load-more only: a cursor, no page numbers.

**Deletion is soft and never reaches Telegram.** [Deleting a post](#deleting-a-post) stops its sync and keeps its comments; comments are never deleted through this API. Reads return deleted rows with `deleted_at` set and leave the presentation to the consumer; writes refuse them with 404. [Resubmitting](#submitting-a-post) a deleted post restores it.

**Edits and deletions made on Telegram are not tracked.** The sync only moves forward. A comment is re-read only when the account [replies](#replying) to it, and a reply to a comment deleted or edited since it was stored is refused after the row is refreshed. See also [Deliberately absent](#deliberately-absent).

**The account's own replies are ordinary comments,** whether sent through this API or from a Telegram client: a `telegram_comments` row with `reply_to` pointing at the answered comment and the account's author fields. The sync skips a reply sent here because its (post_id, telegram_message_id) already exists. There is no own-comment flag; the consumer matches the post's `username` against `author_username`.

**A reply whose parent was deleted on Telegram before it was ever synced** keeps `reply_to` null and lists as a top-level comment. Accepted.

**Submit checks only what it gets for free.** A channel post's thread is resolved at submit anyway, so a channel without a discussion group or a message without a thread is refused there with 400. A bad message id in a supergroup or forum passes submit and fails on the first sync run, see [Submitting a post](#submitting-a-post).

**A job is disabled in two cases only:** the account became unusable (`SessionInvalid` or `UserNotFound`) or the post was deleted. A post's thread never moves, so any other failure is simply retried on the job's next turn, see [Syncing comments](#syncing-comments) and, for the missing backoff, [Open todo](#open-todo).

# API

## Submit post for comment retrieval

METHOD: POST

url: /telegram/v1/posts

headers:
    Authorization: Bearer <jwt-token>
    Content-Type: application/json

body:
{
    "title": "My post",
    "username": "baitcode",
    "url": "<url-format>"
}

url-format:
t.me/<username>/<id>              
t.me/c/<channel_id>/<id>          
t.me/<username>/<topic_id>/<id>   
t.me/c/<channel_id>/<topic_id>/<id>
t.me/<username>/<id>?single       
tg://resolve?domain=<u>&post=<id> 
tg://privatepost?channel=<c>&post=<id> 

Response 201 Created:
{
    "status": 201,
    "id": "01a08dc6-ca2a-70e4-b3a4-f9c760f28b49",
    "created_at": "2026-01-01T10:15:30Z"
}

Response 200 OK (post was already tracked for this username; a deleted post is restored and a disabled sync re-enabled):
{
    "status": 200,
    "id": "01a08dc6-ca2a-70e4-b3a4-f9c760f28b49",
    "created_at": "2026-01-01T10:15:30Z"
}

Response 400 Bad Request:
{
    "status": 400,
    "code": "malformed_url",
    "message": "url does not match any supported form" | "forum link must point at the topic root" | "links to a specific comment are not supported"
}

{
    "status": 400,
    "code": "channel_not_found",
    "message": "url does not resolve to a channel or group"
}

{
    "status": 400,
    "code": "no_discussion_group",
    "message": "channel has no discussion group, so the post has no comment thread"
}

{
    "status": 400,
    "code": "message_not_found",
    "message": "url does not point at a message with a discussion thread"
}

Response 404 Not Found:
{
    "status": 404,
    "code": "user_not_found",
    "message": "user {username} not found"
}

Response 502 Bad Gateway:
{
    "status": 502,
    "code": "upstream_failure",
    "message": "tg api timeout",
    "upstream_error": "some error message"
}

Response 500 Internal Server Error:
{
    "status": 500,
    "code": "session_invalid",
    "message": "telegram session for {username} is not valid",
    "reason": "some error message"
}

{
    "status": 500,
    "code": "flood_wait",
    "message": "telegram asks to wait {retry_after} seconds",
    "reason": "some error message",
    "retry_after": 30
}

## Get post

METHOD: GET

url: /telegram/v1/posts/01a08dc6-ca2a-70e4-b3a4-f9c760f28b49

headers:
    Authorization: Bearer <jwt-token>
    Content-Type: application/json

response:
{
    "status": 200,
    "id": "01a08dc6-ca2a-70e4-b3a4-f9c760f28b49",
    "username": "...",
    "title": "...",
    "url": "...",
    "comments_synced_at": "2026-01-01T10:15:30Z",
    "sync_error": null,
    "comment_sync_enabled": true,
    "created_at": "2026-01-01T10:15:30Z",
    "deleted_at": null
}

Response 404 Not Found:
{
    "status": 404,
    "code": "post_not_found",
    "message": "post {id} not found"
}

## Delete post

METHOD: DELETE

url: /telegram/v1/posts/01a08dc6-ca2a-70e4-b3a4-f9c760f28b49

headers:
    Authorization: Bearer <jwt-token>
    Content-Type: application/json

response:
{
    "status": 200,
    "id": "01a08dc6-ca2a-70e4-b3a4-f9c760f28b49",
    "deleted_at": "2026-01-01T10:15:30Z"
}

Response 404 Not Found:
{
    "status": 404,
    "code": "post_not_found",
    "message": "post {id} not found"
}

## List comments

METHOD: GET

url: /telegram/v1/posts/{post_id}/comments?limit={limit}&cursor={cursor}

headers:
    Authorization: Bearer <jwt-token>
    Content-Type: application/json

response:
{
    "status": 200,
    "items": [
        {
            "id": "01a08dcf-9995-704a-ac33-2c6e6233dcb8",
            "telegram_message_id": 4000,
            "reply_to": null,
            "text": "ololol na bashork",
            "author_name": "...",
            "author_username": "...",
            "author_id": "123456789",
            "has_replies": true,
            "posted_at": "2026-01-01T10:15:30Z",
            "edited_at": null,
            "deleted_at": null
        }
    ],
    "next_cursor": "eyJhZnRlciI6Ii4uLiJ9"
}

Response 404 Not Found:
{
    "status": 404,
    "code": "post_not_found",
    "message": "post {id} not found"
}

## Reply to comments

METHOD: POST

url: /telegram/v1/posts/01a08dc6-ca2a-70e4-b3a4-f9c760f28b49/comments/01a08dcf-9995-704a-ac33-2c6e6233dcb8/reply

headers:
    Authorization: Bearer <jwt-token>
    Content-Type: application/json

body:
{
    "text": "thanks for the feedback"
}

Response 201 Created:
{
    "status": 201,
    "id": "01a08dd3-2b7e-7c11-9a5d-4e8f1c2b3a60",
    "telegram_message_id": 4821,
    "reply_to": "01a08dcf-9995-704a-ac33-2c6e6233dcb8",
    "text": "thanks for the feedback",
    "author_name": "...",
    "author_username": "baitcode",
    "author_id": "987654321",
    "has_replies": false,
    "posted_at": "2026-01-01T10:15:30Z",
    "edited_at": null,
    "deleted_at": null
}

Response 404 Not Found:
{
    "status": 404,
    "code": "comment_not_found",
    "message": "comment {id} not found" | "comment {id} was deleted"
}

{
    "status": 404,
    "code": "post_not_found",
    "message": "post {id} not found" | "post {id} was deleted"
}

{
    "status": 404,
    "code": "user_not_found",
    "message": "user {username} not found"
}

Response 400 Bad Request:
{
    "status": 400,
    "code": "malformed_message",
    "message": "reply text is too long" | "reply text can not be empty"
}

{
    "status": 400,
    "code": "malformed_message_character",
    "message": "reply text contains invalid character at 20",
    "position": 20,
    "codepoint": "U+0000"
}

Response 409 Conflict (the comment was edited on Telegram after it was stored; the row is refreshed and returned, and the same request goes through once resent):
{
    "status": 409,
    "code": "comment_edited",
    "message": "comment {id} was edited since it was stored",
    "comment": {
        "id": "01a08dcf-9995-704a-ac33-2c6e6233dcb8",
        "telegram_message_id": 4000,
        "reply_to": null,
        "text": "ololol na bashorg",
        "author_name": "...",
        "author_username": "...",
        "author_id": "123456789",
        "has_replies": true,
        "posted_at": "2026-01-01T10:15:30Z",
        "edited_at": "2026-01-02T08:00:00Z",
        "deleted_at": null
    }
}

Response 502 Bad Gateway:
{
    "status": 502,
    "code": "upstream_failure",
    "message": "tg api timeout",
    "upstream_error": "some error message"
}

Response 500 Internal Server Error:
{
    "status": 500,
    "code": "session_invalid",
    "message": "telegram session for {username} is not valid",
    "reason": "some error message"
}

{
    "status": 500,
    "code": "flood_wait",
    "message": "telegram asks to wait {retry_after} seconds",
    "reason": "some error message",
    "retry_after": 30
}

## List replies

METHOD: GET

url: /telegram/v1/posts/{post_id}/comments/{comment_id}/replies?limit={limit}&cursor={cursor}

headers:
    Authorization: Bearer <jwt-token>
    Content-Type: application/json

response:
{
    "status": 200,
    "items": [
        {
            "id": "01a08dd3-2b7e-7c11-9a5d-4e8f1c2b3a60",
            "telegram_message_id": 4821,
            "reply_to": "01a08dcf-9995-704a-ac33-2c6e6233dcb8",
            "text": "thanks for the feedback",
            "author_name": "...",
            "author_username": "baitcode",
            "author_id": "987654321",
            "has_replies": false,
            "posted_at": "2026-01-01T10:15:30Z",
            "edited_at": null,
            "deleted_at": null
        }
    ],
    "next_cursor": "eyJhZnRlciI6Ii4uLiJ9"
}

Response 404 Not Found:
{
    "status": 404,
    "code": "comment_not_found",
    "message": "comment {id} not found"
}

{
    "status": 404,
    "code": "post_not_found",
    "message": "post {id} not found"
}


# Telegram library

The service never calls MTProto directly. An internal library wraps it behind six calls and a small error set. The service never sees a session and never string-matches a Telegram error.

## Binding

```text
client = telegram.for_user(username)
```

`for_user` is a handle, not a connection. The library runs as one process per deployment; API handlers and sync workers call into it, and calls for one account are serialised on that account's single MTProto connection. Telegram answers a second concurrent user of a session with `AUTH_KEY_DUPLICATED`, which is why the connection lives in one place however many callers there are, and why calls for one account queue behind each other.

The library fetches the account's session from the credentials service, connects, and keeps the connection. Session storage and refresh stay with that service. The library also hides reconnects, data-centre migration and peer access hashes, and strips the `-100` prefix from any id it is given.

`for_user` raises `UserNotFound` when the credentials service has no session for the username and `Upstream` when that service cannot be reached.

## Methods

All ids are bare integers, all dates UTC.

```text
resolve_peer(ref)                                               -> Peer    { chat_id, kind }
resolve_user(username)                                          -> User    { id, name }
get_discussion_thread(channel_id, message_id)                   -> Thread  { chat_id, root_message_id }
get_thread_messages(chat_id, root_message_id, min_id, limit)    -> Page    { messages: [Message] }
get_messages(chat_id, ids)                                      -> [Message | Deleted]
send_reply(chat_id, reply_to_message_id, text, topic_id = null) -> Sent    { message_id, posted_at }

Message: { id, reply_to_message_id, author: { id, username, name } | null, text, posted_at, edited_at | null }
Deleted: { id }
```

**`resolve_peer`** takes a username or a bare channel id; `kind` is `channel`, `supergroup` or `forum`. [Submit](#submitting-a-post) calls it for every url form: even a numeric url does not say what kind of peer it names.

**`resolve_user`** returns the acting account's own profile, so a [reply](#replying) row carries the author fields the sync would have written. Raises `PeerNotFound` when the username is not a user.

**`get_discussion_thread`** serves [submit](#submitting-a-post), channel posts only. Telegram answers `getDiscussionMessage` with the same `MSG_ID_INVALID` when the channel has no linked discussion group and when the message has no thread, so the library reads the channel's linked chat from `getFullChannel`: none raises `NoDiscussionGroup`, otherwise `MessageNotFound`.

**`get_thread_messages`** wraps `getReplies` and its ceiling of 100 per call: messages with id above `min_id`, ascending, at most `limit`. The [sync](#syncing-comments) passes the last id it has and takes one page per run; the rest waits for the next run. `reply_to_message_id` is never null, a top-level comment answers the thread root. `edited_at` is Telegram's edit date.

**`get_messages`** wraps `getMessages` on the chat that holds the thread, at most 100 ids per call, order not guaranteed. A message Telegram no longer returns, deleted or currently invisible to the account, comes back as `Deleted`, and the [reply handler](#replying) treats both as deleted: a reply attempted while the account temporarily cannot see the chat marks its target deleted for good. Accepted.

**`send_reply`** posts the reply; `topic_id` becomes `top_msg_id` for forum posts.

## Errors

```yaml
# where each error is raised, and what each context that can meet it does
UserNotFound:
  raised_by:      for_user
  submit, reply:  404 user_not_found
  sync:           as SessionInvalid, written to sync_error and the job is disabled

PeerNotFound:
  raised_by:      [resolve_peer, resolve_user]
  submit:         400 channel_not_found, from resolve_peer
  reply:          502 upstream_failure, from resolve_user, since the bound account's own username failing to resolve is not a client error

NoDiscussionGroup:
  raised_by:      get_discussion_thread
  submit:         400 no_discussion_group, the channel has no linked group and linking one later gives an existing post no thread

MessageNotFound:
  raised_by:      [get_discussion_thread, send_reply, get_thread_messages]
  submit:         400 message_not_found
  reply:          404 comment_not_found, and the comment is marked deleted
  sync:           written to sync_error

Forbidden:
  raised_by:      send_reply
  reply:          502 with the reason, until a 403 mapping is in scope

FloodWait(retry_after):
  raised_by:      any
  submit, reply:  500 flood_wait carrying retry_after, 429 with Retry-After once rate limits are in scope
  sync:           written to sync_error, the job comes round again in its turn

SessionInvalid:   # the user revoked the session
  raised_by:      any
  submit, reply:  500 session_invalid
  sync:           written to sync_error and the job is disabled

Upstream:
  raised_by:      any
  submit, reply:  502 upstream_failure, raw message in upstream_error
  sync:           written to sync_error
```

## Deliberately absent

No history fetch beyond a thread, no sweep over known messages, and no subscription to Telegram's update stream, so no persistent listener and no per-chat `pts` bookkeeping. The sync only moves its high-water mark forward; an edit or deletion is noticed when the [reply handler](#replying) re-reads its one target through `get_messages`. The update stream would catch edits and deletions as they happen and is the upgrade path if that comes to matter.

# Database schema

PostgreSQL 18 or later, for `uuidv7()`. All ids are UUIDv7, assigned by the database on insert. `username` is the Telegram account on whose behalf the service acts when syncing and replying; it is an attribute of the post, not an access scope. No credentials are stored (see Assumptions).

## Platform specific

### Posts

```sql
create table telegram_posts (
    id                      uuid primary key default uuidv7(),
    username                text not null,

    -- for UI
    title                   text not null,
    url                     text not null,

    -- parsed from url
    post_type               text not null
                            check (post_type in ('channel', 'forum', 'supergroup')),             

    message_id              bigint not null,    
    channel_id              bigint not null, -- bare id as in t.me/c/ links and MTProto, never the -100 Bot API form (prefix stripped on parse);
                                             -- resolved in the submit handler for username url forms
    forum_topic_id          bigint,          -- set from post_type, not from the url: message_id for a forum post, since only
                                             -- topic roots are accepted and a topic's root id is its topic id; null otherwise

    -- channel posts only, resolved in the submit handler via the library's get_discussion_thread: the linked discussion
    -- group and the auto-forwarded copy of the post, which is where the comment thread lives; fixed when the post is
    -- published, so never rewritten. Null for supergroup and forum posts, whose thread is in channel_id itself, rooted
    -- at message_id (supergroup) or forum_topic_id (forum)
    discussion_chat_id      bigint,
    discussion_message_id   bigint,          

    -- syncing metadata
    last_synced_at          timestamptz,     -- last successful sync; returned as comments_synced_at
    last_synced_message_id  bigint,          -- high-water mark for incremental fetch
    sync_error              text,            -- last sync error

    -- bookkeeping
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),
    deleted_at              timestamptz 
);

-- one tracked post per account; different url forms of the same post collapse because channel_id is always resolved.
-- covers all post types: for forum and supergroup posts channel_id is the group id, and message ids are
-- unique per chat regardless of topic, so forum_topic_id is not part of the key
create unique index telegram_posts_username_channel_message_uniq
    on telegram_posts (username, channel_id, message_id);
```

### Comments

```sql
create table telegram_comments (
    id                      uuid primary key default uuidv7(), -- the listings page by it: generation must stay monotonic
                                                                -- and on the database clock, see Listing comments
    post_id                 uuid not null references telegram_posts (id),

    telegram_message_id     bigint not null, -- id in the chat that holds the thread; needed to reply
    reply_to_message_id     bigint not null, -- the message this one answers on Telegram, as the library reports it: a
                                             -- comment's parent, or the thread root for a top-level comment. the sync
                                             -- resolves it into reply_to; the root is not a comment row, so that stays null
    
    reply_to                uuid references telegram_comments (id),
                                             -- parent comment for nested threads; null for top level, and null when the
                                             -- parent was never ingested (deleted on Telegram before the first sync)

    author_id               bigint,          -- telegram user id; null for anonymous / channel-signed comments
    author_username         text,            -- nullable, not every user has one
    author_name             text,            -- null exactly when author_id is

    text                    text not null,
    posted_at               timestamptz not null,  -- telegram date
    edited_at               timestamptz,     -- telegram edit date
    deleted_at              timestamptz,     -- telegram deletion detection date

    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),

    unique (post_id, telegram_message_id)
);

-- serves the per-comment replies listing and the has_replies probe, paged by id
create index telegram_comments_reply_to_idx
    on telegram_comments (reply_to, id)
    where reply_to is not null;

-- serves the top-level comment listing, paged by id
create index telegram_comments_top_level_idx
    on telegram_comments (post_id, id)
    where reply_to is null;
```

## Common

### Comment sync jobs and runs

```sql
-- one persistent row per post; created on submit, never deleted
create table post_comments_sync_jobs (
    id                      uuid primary key default uuidv7(),
    post_id                 uuid not null,
    platform                text not null check (platform in ('telegram')),

    -- true: scheduler keeps picking it up forever, ordinary failures included; false: post sync is disabled.
    -- set false by a run on SessionInvalid or UserNotFound and by post deletion
    is_active               boolean not null default true,

    -- lease. locked_at is when the job was last picked and is never cleared: the scheduler orders by it, so
    -- picking is round-robin with never-picked jobs first. locked_until is the lease expiry, set on pick, pushed
    -- forward by the run while its upstream call is in flight, and cleared on release; a lease that expired
    -- without release is stale and the job is eligible again. lease_token is issued fresh by every pick and
    -- fences every write a run makes to this row and to the post, see Syncing comments
    locked_at               timestamptz,
    locked_until            timestamptz,
    lease_token             uuid
);

-- one job row per post
create unique index post_comments_sync_jobs_platform_post_uniq
    on post_comments_sync_jobs (platform, post_id);

-- scheduler walks active jobs in pick order, least recently locked first, and skips the ones whose lease is held.
-- the pick needs nothing from telegram_posts
create index post_comments_sync_jobs_due_idx
    on post_comments_sync_jobs (locked_at asc nulls first)
    where is_active;
```

```sql
-- one row per sync run, inserted when the run starts and completed when it finishes; never updated after that.
-- grows without bound under endless polling; retention is accepted as out of scope for this design
create table post_comments_sync_runs (
    id                      uuid primary key default uuidv7(),
    post_id                 uuid not null,
    platform                text not null check (platform in ('telegram')),
    job_id                  uuid not null references post_comments_sync_jobs (id),

    started_at              timestamptz not null,
    finished_at             timestamptz,         -- null while the run is in progress
    status                  text not null default 'running'
                            check (status in ('running', 'success', 'failure')),
    error                   text                 -- null on success
);

-- latest runs per post, for audit and debugging; started_at is never null so the order is total
create index post_comments_sync_runs_post_idx
    on post_comments_sync_runs (post_id, started_at desc);
```

# Notes

Handlers and the sync worker, in the order a post moves through them. Library errors map to responses per [Errors](#errors); the notes add only what a handler does beyond that.

## Submitting a post

Endpoint: [Submit post for comment retrieval](#submit-post-for-comment-retrieval).

1. **Parse the url.** 400 `malformed_url` if it matches no supported form, links to a specific comment (`?comment=`), or is a forum link whose last segment is not the topic id: Telegram keeps no thread for a message inside a topic, and there is no dedicated code for it. A two-segment forum link is taken as a topic root, which the url cannot prove, so a link to an ordinary message inside a topic passes and fails on its first sync run.
2. **Resolve the peer.** Bind `for_user(username)` and call `resolve_peer` with the username or bare id from the url. `kind` becomes `post_type`, since the url cannot tell a channel from a supergroup. `forum_topic_id` is `message_id` for a forum and null otherwise; a topic segment in a url to a non-forum peer is ignored.
3. **Resolve the thread, channel posts only.** `get_discussion_thread(channel_id, message_id)` gives `discussion_chat_id` and `discussion_message_id`. `NoDiscussionGroup` and `MessageNotFound` are 400 and store nothing, because nothing could ever be synced: a channel post's thread is the reply thread of the copy forwarded into the linked group when the post is published, and linking a group later forwards new posts only, so the owner has to repost. This runs before the insert, so a resubmit of a tracked post whose group or copy is gone is refused the same way and leaves the post as it was. Supergroup and forum posts get no check here; a bad message id surfaces in `sync_error` on the first run.
4. **Insert the post.** The unique index on (username, channel_id, message_id) is the only duplicate check. On conflict, in one transaction: clear `deleted_at`, re-enable a disabled job and clear `sync_error`; return 200 with the existing id. Step 3's result is not written: a thread is fixed at publish time and equals what is stored.
5. **Insert the sync job**, active, and return 201.

## Thread coordinates

Where a post's comment thread lives, by `post_type`. Submit fills these; [Syncing comments](#syncing-comments) and [Replying](#replying) read them from the post row.

```yaml
channel:    { chat_id: discussion_chat_id, root_message_id: discussion_message_id, topic_id: null }
supergroup: { chat_id: channel_id,         root_message_id: message_id,            topic_id: null }
forum:      { chat_id: channel_id,         root_message_id: forum_topic_id,        topic_id: forum_topic_id }
```

## Syncing comments

A scheduler loop picks jobs and does nothing else; one run per picked job does the work. A run resolves nothing: it fetches with the stored [thread coordinates](#thread-coordinates).

**Pick.** Each tick, take a batch of active jobs whose lease is free or expired, least recently locked first, and lease them in the same statement. A never-locked job sorts first, so a new post gets its first run promptly; after that picking is round-robin.

```sql
update post_comments_sync_jobs j
    set 
        locked_at = now(), 
        locked_until = now() + $lease_timeout,
        lease_token = uuidv7()
where j.id in (
    select id from post_comments_sync_jobs
    where is_active and (locked_until is null or locked_until < now())
    order by locked_at asc nulls first
    limit $batch_size
    for update skip locked
)
returning j.id, j.post_id, j.platform, j.lease_token;
```

**Lease.** Each returned job starts a run as a background task: one upstream call and a short transaction, so `$lease_timeout` is sized for a normal call. While the call is in flight a heartbeat pushes `locked_until` forward by `$lease_timeout` whenever less than half of it is left, so a call queued behind others on the same account connection does not get the job picked twice.

**Fence.** The pick issues a fresh `lease_token`, and every write a run makes to the job or the post carries `where lease_token = $token`: the heartbeat, and the first statement of each run transaction, which re-takes the job row `for update`. The token changes only when the job is picked again, so an expired lease nobody has taken yet still matches and the heartbeat revives it. Zero rows means another run holds the job: this one rolls back, closes its run row as `failure` with `lease lost`, and stops, having written nothing else; the new holder refetches the same page. A heartbeat refused the same way is early notice, and the run may stop waiting for its call.

**Run.**

1. Open a run row as `running`.
2. Bind `for_user(post.username)` and call `get_thread_messages(chat_id, root_message_id, last_synced_message_id, 100)` once. One page per run, so a backlog catches up 100 comments per run.
3. On success, in one fenced transaction: insert the messages with `on conflict (post_id, telegram_message_id) do nothing`, so a reply sent through this API, or any row already known, is left as it is; new rows take `edited_at` from the message. Set `reply_to` on the new rows by joining `reply_to_message_id` to the post's comments on `telegram_message_id`; the thread root is not a comment row, so top-level comments stay null, as does a reply whose parent never came through. A parent always has a lower id than its reply and pages ascend, so it is in this page or an earlier one. Set `last_synced_message_id` to the largest id in the page, unchanged if the page is empty; set `last_synced_at`; clear `sync_error`. Close the run as `success` and release the lease by clearing `locked_until`.
4. On any library error, in one fenced transaction: write it to `sync_error`, close the run as `failure`, release the lease. On `SessionInvalid` or `UserNotFound` also set `is_active` to false: retrying cannot help until the account is back in the credentials service with a valid session.

There are no retries; the job comes round again in its turn.

## Reading a post

Endpoint: [Get post](#get-post).

Read the post by id and join its job; only an unknown id is 404. `comments_synced_at` is `last_synced_at`, the last success; `comment_sync_enabled` is the job's `is_active`; `sync_error`, the last failure, keeps its name. Read success and failure together: both null, no run yet; only `sync_error` set, nothing has succeeded yet; both set, the last run failed after an earlier success and the comments are as of `comments_synced_at`.

## Deleting a post

Endpoint: [Delete post](#delete-post).

Load the post by id; only an unknown id is 404. In one transaction set `deleted_at` if it is null and the job's `is_active` to false; return 200 with `deleted_at`, and the same body on a repeat. A run in flight finishes and releases its lease; the scheduler reads `is_active`, so the job is not picked again. Comments are kept, reads keep serving the post, and [resubmitting](#submitting-a-post) restores it.

## Listing comments

Endpoint: [List comments](#list-comments).

Top-level rows only, `reply_to` null, paged by `id` ascending through the partial index on (post_id, id); the cursor is base64 of `{"after": <id>}` and `next_cursor` is null on the last page. Nested replies come from [Listing replies](#listing-replies). A deleted post still lists; only an unknown post id is 404.

**Why page by id.** A UUIDv7 assigned by the database on insert sorts after every cursor already handed out, whichever path inserted the row, so load-more never skips one. `telegram_message_id` would not do: a reply sent here gets a Telegram id above a comment the sync has not ingested yet, and a cursor past the reply would skip that comment when it arrives. The order is therefore ingestion order, with `posted_at` on every item for a consumer that wants Telegram order. The one gap is a read between the commits of two overlapping insert transactions when the later one carries the smaller ids, a window the length of [sync step 3](#syncing-comments). Accepted.

**Items.** Deleted and edited rows are returned like any other, with `deleted_at`, `edited_at` and the last known text, so a deleted parent never hides its replies. `has_replies` is an exists probe over the partial index on (reply_to, id), one per row. `author_id` is a string to avoid precision loss. There is no own-comment flag, see [Assumptions](#assumptions).

## Listing replies

Endpoint: [List replies](#list-replies).

Load the comment by (id, post_id); only an unknown id is 404, a deleted comment still lists its replies. Return its direct children, rows whose `reply_to` is its id, paged as [comments](#listing-comments) are, through the partial index on (reply_to, id). Items are comment items and include replies from anyone, not only those sent through this API.

## Replying

Endpoint: [Reply to comments](#reply-to-comments).

1. **Validate the text** before touching Telegram: empty, too long or an invalid character is 400.
2. **Load the post, then the comment** by (id, post_id). A deleted post is 404 `post_not_found`, a deleted comment 404 `comment_not_found`, both with the "was deleted" message. Disabled sync does not block a reply. `chat_id` and `topic_id` come from [Thread coordinates](#thread-coordinates).
3. **Re-read the target.** Bind `for_user(post.username)` and call `get_messages(chat_id, [telegram_message_id])`. The sync never re-reads a message it has, so the reply checks its own target and refreshes the row before answering:
   - `Deleted`: set `deleted_at`, 404 `comment_not_found`.
   - `edited_at` differs from the row: store the new `text` and `edited_at`, 409 `comment_edited` with the refreshed item. The consumer sees what it is now answering and resends; the retry compares equal.
   - same `edited_at`: continue.

   A refused reply leaves nothing on Telegram.
4. **Send.** `resolve_user(post.username)` for the account's id and name, then `send_reply(chat_id, telegram_message_id, text, topic_id)`. `PeerNotFound` from `resolve_user` comes before the send, so nothing was posted. `MessageNotFound` from the send means the target went since step 3: mark the comment deleted, 404.
5. **Store the reply** as a `telegram_comments` row: the returned `message_id` and `posted_at`, the target's id as `reply_to` and its `telegram_message_id` as `reply_to_message_id`, the text, and `post.username` with the resolved id and name as author fields. On conflict on (post_id, telegram_message_id) the sync got there first and its row is complete, so use it. Return 201 with the row as a comment item. If the insert fails after Telegram accepted the message, the next sync run ingests it. Accepted.

# Open todo

- No backoff in the sync path. A job that hits `FloodWait`, or a thread that fails for good, such as one whose root was deleted on Telegram, is eligible again on the next tick and fails again in its turn, forever. `retry_after` is written to `sync_error` and otherwise discarded, and all jobs of one account share a serialised connection, so they walk into the same wait one after another. The tick interval, the batch size and a per-job minimum interval are not defined either. Candidate: a `not_before` on the job, set from `retry_after` on `FloodWait` and pushed out on repeated failures, and honoured by the pick.

