---
title: Privacy Policy
description: What information the Pockode relay service, cloud accounts and pockode.com collect, and how it is used and shared.
---

**Effective Date:** October 28, 2026

This Privacy Policy describes how Pockode ("we," "us," or "our") collects, uses, and shares information in connection with your use of the Pockode relay service, Pockode cloud accounts, and website (collectively, the "Service").

By using the Service, you agree to the collection and use of information in accordance with this policy.

## 1. Information We Collect

### 1.1 Information Collected Automatically

When you use our relay service, we automatically collect certain technical information necessary to provide and maintain the Service:

- **Network Information:** IP addresses of connecting clients and servers
- **Connection Data:** Timestamps, session identifiers, and connection duration
- **Technical Logs:** Error logs and diagnostic information for troubleshooting

The Pockode server also fetches a short announcement from us each time it starts, even when the relay is turned off (`-relay=false`). That request sends nothing from your machine or projects; we receive only its IP address and the time it was made, which we handle as described in this policy.

### 1.2 Cloud Account Information

A cloud account is optional. If you sign in to the cloud and link a machine with `pockode login`, we receive the following so that we can show you your instances:

- **Account:** Your email address, which is your account; there is no password. We send a one-time sign-in code to it each time you sign in.
- **Linked Machine:** The machine's hostname, your operating system user name on it, and its operating system, sent when you link it. The machine is named `user@hostname` in your account.
- **Linked Instances:** For each Pockode instance that runs on a linked machine, its kind (server, cluster, or node), its name, and the path it runs in — the project directory for a server or node, the data directory for a cluster. These are sent when the instance starts and each time it renews its relay registration.
- **Last Seen:** When each linked instance last connected to or disconnected from the relay.

A machine that has not been linked sends none of this: its requests to the relay are the same as if accounts did not exist.

To stop sending it, run `pockode logout` on the machine, or unlink the machine from your account on the web. Either one deletes the machine from your account, and its instances are no longer associated with it or shown in your list. An instance that is offline can also be removed from the list on its own; it reappears the next time it renews its registration from a linked machine.

### 1.3 Information We Do Not Collect

We do not inspect, log, or store the content of data transmitted through the relay service. Your code, messages, and other communications pass through our infrastructure without content inspection.

### 1.4 AI and Machine Learning

**We do not use your code, communications, or any data transmitted through our Service to train AI or machine learning models.**

Pockode provides relay infrastructure that enables you to use AI-powered coding tools. When you use third-party AI services (such as Claude, OpenAI, or others) through Pockode, your interactions with those services are governed by their respective privacy policies. We recommend reviewing the privacy policies of any AI service you choose to use.

### 1.5 Website

Our website does not use cookies, tracking pixels, or third-party analytics services. The cloud account pages set a single cookie, the session cookie that keeps you signed in: it is set only when you sign in, lasts up to 30 days and is renewed while you keep using the pages, and is removed when you sign out. They do not use tracking pixels or third-party analytics services either.

## 2. How We Use Information

We use the information we collect for the following purposes:

- **Service Provision:** To operate, maintain, and provide the relay service
- **Your Instance List:** To show you, and only you, the machines and instances linked to your account, and to send you sign-in codes by email. Cloud account information is not shown to anyone other than the account owner
- **Security:** To detect, prevent, and respond to security incidents, fraud, or abuse
- **Troubleshooting:** To diagnose technical problems and improve service reliability
- **Legal Compliance:** To comply with applicable laws and legal obligations

## 3. Information Sharing

We do not sell, rent, or trade your personal information. We may share information only in the following circumstances:

- **Legal Requirements:** When required by law, subpoena, or other legal process
- **Protection of Rights:** To protect our rights, property, or safety, or that of our users or the public
- **Service Providers:** With third-party service providers who assist in operating our infrastructure, subject to confidentiality obligations

## 4. International Data Transfers

The Service is operated from Japan. If you access the Service from outside Japan, your information may be transferred to, stored, and processed in Japan or other countries where our service providers operate. By using the Service, you consent to such transfers.

## 5. Changes to This Policy

We may update this Privacy Policy from time to time. We will notify you of any material changes by posting the new Privacy Policy on this page and updating the "Effective Date" above. Your continued use of the Service after such changes constitutes acceptance of the updated policy.
