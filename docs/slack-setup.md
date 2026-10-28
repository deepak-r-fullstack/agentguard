# Set up Slack approvals

This takes about 10 minutes and is done once, by whoever looks after your AgentGuard server and a Slack admin. Nothing here is needed for AgentGuard to work: without it, approvals stay in the web app.

When it is on, an agent's request that needs a person appears in your Slack channel with **Approve** and **Reject** buttons.

## Before you start

You need:

- the public address of your AgentGuard server, for example `https://agentguard.example.com`. Slack must be able to reach it from the internet, so `localhost` will not work (use a tunnel such as ngrok when trying it locally);
- permission to add an app to your Slack workspace;
- AgentGuard accounts for the people who will approve. **They must use the same email in Slack and in AgentGuard**, because that is how AgentGuard knows who clicked.

## 1. Create the Slack app

1. Go to <https://api.slack.com/apps> and choose **Create New App**, then **From a manifest**.
2. Pick your Slack workspace.
3. Paste the manifest below (choose the **YAML** tab). Replace `https://YOUR-APP` with your AgentGuard address.
4. Review and choose **Create**.

```yaml
display_information:
  name: AgentGuard
  description: Approve or reject what your AI agents want to do, right from Slack.
  background_color: "#1f3a5f"
features:
  bot_user:
    display_name: AgentGuard
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write          # post and update approval messages
      - users:read          # look up who clicked a button
      - users:read.email    # match them to their AgentGuard account by email
settings:
  interactivity:
    is_enabled: true
    request_url: https://YOUR-APP/api/integrations/slack/interactions
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

## 2. Install it and copy two values

1. In the app, open **Install App** and choose **Install to Workspace**, then **Allow**.
2. Copy the **Bot User OAuth Token** (it starts with `xoxb-`). This is `SLACK_BOT_TOKEN`.
3. Open **Basic Information** and copy the **Signing Secret**. This is `SLACK_SIGNING_SECRET`.

Keep both private. Never put them in the repository, in a chat or in a screenshot.

## 3. Give them to AgentGuard

On Render: open your service, then **Environment**, and add:

| Name | Value |
| --- | --- |
| `SLACK_BOT_TOKEN` | the `xoxb-...` token |
| `SLACK_SIGNING_SECRET` | the signing secret |

Save. Render restarts the service. (Running it yourself? Put the same two lines in `server/env/local.env`.)

## 4. Pick the channel

1. In Slack, open the channel for approvals. Choose **Integrations**, then **Add apps**, and add **AgentGuard**. (A private channel needs the app invited with `/invite @AgentGuard`.)
2. Right-click the channel name, choose **View channel details**, and copy the **Channel ID** at the bottom (it looks like `C0123456789`).
3. In AgentGuard, sign in as an admin and open **Connections**. Paste the channel ID and choose **Save**.
4. Choose **Send test message**. A short hello should appear in the channel.

## 5. Try it

Ask an agent to do something that needs approval (for example cancel booking `BK-1001` in the demo). The request appears in Slack. A manager or admin clicks **Approve** or **Reject**, and the message changes to show who decided and what happened.

## If something does not work

| What you see | What to check |
| --- | --- |
| "Slack is not set up yet" on the Connections page | Both `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` must be set, and the server restarted. |
| Test message says to add the app to the channel | Add AgentGuard to the channel (step 4.1). |
| Test message says it cannot find the channel | Re-copy the channel ID. It starts with `C` or `G`. |
| Clicking a button in Slack shows "This app responded with status code 401" | The signing secret is wrong, or the server's clock is off by more than 5 minutes. |
| You see "We could not read your email from Slack" | The app needs the `users:read.email` scope. Add it under **OAuth & Permissions**, then reinstall the app. |
| You see "Your Slack email does not match a person" | The person's Slack email must match their AgentGuard email, in the same company. |
| You see "Only managers and admins can approve" | Auditors can watch but not decide. |
| You see "You cannot approve an action that was requested on your behalf" | Another manager has to decide it. This is on purpose. |
| Nothing appears in Slack, but approvals work in the web app | Slack is optional and never blocks agents. The server log shows a `slack approval message failed` line with the Slack error code (no names or message text). |
