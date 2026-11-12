---
title: Privacy Policy
description: What information the Pockode relay service, cloud accounts and pockode.com collect, and how it is used and shared.
---

**Effective Date:** October 30, 2026

This Privacy Policy describes how Pockode ("we," "us," or "our") collects, uses, and shares information in connection with your use of the Pockode relay service, Pockode cloud accounts, and website (collectively, the "Service").

By using the Service, you agree to the collection and use of information in accordance with this policy.

## 1. Information We Collect

### 1.1 Information Collected Automatically

When you use our relay service or the cloud account pages, we automatically collect certain technical information necessary to provide and maintain the Service:

- **Network Information:** IP addresses of connecting clients and servers
- **Connection Data:** Timestamps, session identifiers, and connection duration
- **Technical Logs:** Error logs and diagnostic information for troubleshooting

The Pockode server also fetches a short announcement from us each time it starts, even when the relay is turned off (`-relay=false`). That request sends nothing from your machine or projects; we receive only its IP address and the time it was made, which we handle as described in this policy.

### 1.2 Cloud Account Information

A cloud account is optional; [Cloud account](/docs/cloud/) describes how it works. If you sign in to the cloud, we receive your email address; if you also link a machine — with `pockode login`, or from Pockode's Settings or cluster panel — we receive information about that machine and the Pockode instances on it, so that we can show you your instances:

- **Account:** Your email address, which identifies your account (there is no password). We send a one-time sign-in code to it each time you sign in.
- **Linked Machine:** The machine's hostname, your operating system user name on it, and its operating system, sent when you link it. The machine is named `user@hostname` in your account.
- **Linked Instances:** For each Pockode instance your operating system user runs on a linked machine, its kind (server, cluster, or node) and the name and full path of its directory — the project directory for a server or node, the data directory for a cluster. These are sent each time the instance registers or renews its relay connection.
- **Last Seen:** When each linked instance last registered with, renewed its registration with, connected to, or disconnected from the relay.

A machine that has never been linked sends none of this: its requests to the relay are the same as if accounts did not exist.

How long each of these is kept, and how to delete them, is described in [Retention and Deletion](#4-retention-and-deletion).

### 1.3 Information We Do Not Collect

We do not inspect, log, or store the content of data transmitted through the relay service. Your code, messages, and other communications pass through our infrastructure without content inspection.

### 1.4 AI and Machine Learning

**We do not use your code, communications, or any data transmitted through our Service to train AI or machine learning models.**

Pockode provides relay infrastructure that enables you to use AI-powered coding tools. When you use third-party AI services (such as Claude, OpenAI, or others) through Pockode, your interactions with those services are governed by their respective privacy policies. We recommend reviewing the privacy policies of any AI service you choose to use.

### 1.5 Website

Our website does not use cookies, tracking pixels, or third-party analytics services. Neither do the cloud account pages, except for two cookies that are needed to sign you in. Both are set only by the cloud account site itself, are sent only over HTTPS, and cannot be read by scripts on the page:

- **Sign-in challenge cookie (`__Host-login-challenge`):** Set when you ask for a sign-in code, and lasts 10 minutes, as long as the code. It only ties the code to the browser that asked for it, so that a code read by someone else cannot be used from another browser. It is removed once you sign in with that code.
- **Session cookie (`__Host-session`):** Set when you sign in, and keeps you signed in. It lasts up to 30 days and is renewed while you keep using the pages. It is removed when you sign out, from that browser only. When you delete your account, it is removed from that browser, and your sessions in every other browser stop working at the same moment.

## 2. How We Use Information

We use the information we collect for the following purposes:

- **Service Provision:** To operate, maintain, and provide the relay service
- **Cloud Accounts:** To send you sign-in codes by email, and to show you the machines and instances linked to your account. Cloud account information is shown only to the account owner, except that a linked machine's terminal shows the email address of the account it is linked to
- **Security:** To detect, prevent, and respond to security incidents, fraud, or abuse
- **Troubleshooting:** To diagnose technical problems and improve service reliability
- **Legal Compliance:** To comply with applicable laws and legal obligations

## 3. Information Sharing

We do not sell, rent, or trade your personal information. We may share information only in the following circumstances:

- **Legal Requirements:** When required by law, subpoena, or other legal process
- **Protection of Rights:** To protect our rights, property, or safety, or that of our users or the public
- **Service Providers:** With third-party service providers who assist in operating our infrastructure, such as hosting and email delivery (which handles the sign-in codes we send you), subject to confidentiality obligations

## 4. Retention and Deletion

### 4.1 How Long We Keep Information

- **Account:** Your email address is kept for as long as your account exists, and is deleted when you delete your account.
- **Sign-in Codes:** When you ask for a sign-in code, we keep a record of the request: the email address it was sent to, the code and its browser binding in hashed form, the number of attempts, and when it was sent and used. This happens whether or not that email address has an account. The code expires after 10 minutes. The record is kept for one hour so that we can limit how many codes are sent to one address, and is then deleted automatically, normally within the next hour. To limit abuse we also count requests per IP address for one hour; that count is kept only in memory.
- **Sessions:** A session lasts up to 30 days and is renewed while you keep using the pages. It is deleted when you sign out, and an expired session is deleted automatically, normally within an hour.
- **Machine Link Requests:** When you start linking a machine, we keep the machine's name and operating system until the request is completed. It is deleted as soon as the machine is linked; a request that is not completed expires after 10 minutes and is then deleted automatically, normally within an hour.
- **Linked Machines and Instances:** A linked machine, and the kind, name, path and last-seen time of each instance on it, are kept until you unlink the machine or delete your account. Each time an instance renews its registration, its kind, name and path are replaced with the current ones.
- **Relay Addresses:** An instance's relay address and the credential it uses to keep that address are kept with no time limit, so that the instance keeps the same address. They are not deleted when the instance is unlinked or your account is deleted; they are then no longer associated with any account.
- **Technical Logs:** Logs include the network information and connection data described in [Information Collected Automatically](#11-information-collected-automatically), and relay addresses. They are kept only as long as needed for troubleshooting and security, and identify an account by an internal number, never by email address.

### 4.2 Unlinking a Machine or an Instance

Run `pockode logout` on the machine, or unlink the machine from your account on the web. Either one deletes the machine from your account, along with the kind, name, path and last-seen time of its instances. `pockode logout` also removes the link from the machine itself, so it stops sending this information; if the cloud cannot be reached at that moment, unlink the machine on the web to remove it from your account. A machine unlinked only on the web keeps its link file, so its instances go on sending the machine credential and their kind, name and path each time they renew their registration; we do not store these, and `pockode logout` on the machine stops this. An instance that is offline can also be removed from the list on its own, which deletes its kind, name, path and last-seen time; it reappears the next time it renews its registration from a linked machine.

### 4.3 Deleting Your Account

You can delete your account yourself on the web: choose **Delete account** in the account menu and confirm by typing your email address. Deletion takes effect immediately and cannot be undone. It deletes, all at once:

- your email address and your account;
- every machine linked to your account, and the kind, name, path and last-seen time of their instances;
- your sessions in every browser, which signs you out everywhere;
- machine link requests you approved that have not yet been completed (requests not yet approved belong to no account, and are deleted as described in [How Long We Keep Information](#41-how-long-we-keep-information));
- the records of sign-in codes sent to your email address.

Your Pockode instances are not stopped and keep working at the same relay address, as instances without an account do. A linked machine is told that it is no longer linked the next time one of its instances renews its registration. Like a machine unlinked on the web, it goes on sending the information we no longer store until you run `pockode logout` on it. Signing in again with the same email address creates a new, empty account.

Technical logs are not deleted with the account; they are kept as described in [How Long We Keep Information](#41-how-long-we-keep-information). Database backups made before the deletion are not changed by it, and may still contain the deleted information.

## 5. International Data Transfers

The Service is operated from Japan. If you access the Service from outside Japan, your information may be transferred to, stored, and processed in Japan or other countries where our service providers operate. By using the Service, you consent to such transfers.

## 6. Changes to This Policy

We may update this Privacy Policy from time to time. We will notify you of any material changes by posting the new Privacy Policy on this page and updating the "Effective Date" above. Your continued use of the Service after such changes constitutes acceptance of the updated policy.
