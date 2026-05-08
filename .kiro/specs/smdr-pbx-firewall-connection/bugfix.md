# Bugfix Requirements Document

## Introduction

The Matrix PBX at 192.168.0.81 is configured to push SMDR call records to the UniComm server via TCP. The SMDR service (`backend/services/matrixSmdr.js`) runs a TCP server that listens for inbound connections from the PBX. However, Windows Firewall on the server machine is blocking the inbound TCP connection on the SMDR port, so the PBX never successfully connects and no call logs are recorded.

Additionally, there is a port mismatch: the SMDR service defaults to port `5000` when `SMDR_PORT` is not set in `.env`, but the deployment documentation and simulator both use port `5001`. If `.env` does not explicitly set `SMDR_PORT=5001`, the service listens on the wrong port, causing the PBX connection to fail even after the firewall is opened.

The user attempted to add a firewall rule manually via `netsh` but received: *"The requested operation requires elevation (Run as administrator)."*

---

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the UniComm server starts and `SMDR_PORT` is not set in `.env` THEN the system listens on port `5000` instead of the expected port `5001`

1.2 WHEN the Matrix PBX at 192.168.0.81 attempts a TCP connection to the server on the SMDR port THEN the system drops the connection because Windows Firewall has no inbound allow rule for that port

1.3 WHEN a user runs `netsh advfirewall firewall add rule ...` in a non-elevated terminal THEN the system returns "The requested operation requires elevation (Run as administrator)" and the firewall rule is not created

1.4 WHEN the PBX cannot connect due to the firewall block THEN the system records no call logs and the dashboard shows no SMDR data

### Expected Behavior (Correct)

2.1 WHEN the UniComm server starts THEN the system SHALL read `SMDR_PORT` from `.env` with the correct value of `5001`, ensuring the service listens on the same port the PBX is configured to push to

2.2 WHEN the Matrix PBX at 192.168.0.81 attempts a TCP connection to the server on the SMDR port THEN the system SHALL accept the connection because a Windows Firewall inbound allow rule exists for that TCP port

2.3 WHEN the firewall rule is added (via an elevated PowerShell command or a provided setup script) THEN the system SHALL allow inbound TCP traffic on the SMDR port without requiring manual intervention on every deployment

2.4 WHEN the PBX successfully connects THEN the system SHALL receive SMDR records, parse them, save them to the database, and emit real-time events to the dashboard

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the PBX is connected and sending SMDR data THEN the system SHALL CONTINUE TO parse each SMDR line and save a call log record to the `call_logs` table

3.2 WHEN a valid SMDR line is received THEN the system SHALL CONTINUE TO emit a `pbx:call` Socket.IO event to connected dashboard clients

3.3 WHEN the PBX disconnects and reconnects THEN the system SHALL CONTINUE TO accept the new connection and resume recording call logs

3.4 WHEN `SMDR_PORT` is explicitly set in `.env` THEN the system SHALL CONTINUE TO use that configured value, with no change to the existing env-var override behaviour

3.5 WHEN the SMDR simulator (`backend/scratch/smdr_simulator.js`) is run against the local server THEN the system SHALL CONTINUE TO accept its connection and process the simulated records

---

## Bug Condition (Pseudocode)

**Bug Condition Function** — identifies the inputs/state that trigger the connection failure:

```pascal
FUNCTION isBugCondition(env, firewallRules)
  INPUT: env — the server's .env configuration
         firewallRules — the set of active Windows Firewall inbound rules
  OUTPUT: boolean

  portMismatch    ← env.SMDR_PORT is undefined AND service default ≠ 5001
  firewallBlocked ← NOT EXISTS rule IN firewallRules WHERE
                      rule.direction = IN AND
                      rule.protocol  = TCP AND
                      rule.localport = env.SMDR_PORT (or service default)

  RETURN portMismatch OR firewallBlocked
END FUNCTION
```

**Fix Checking Property:**

```pascal
// Property: PBX can connect after fix
FOR ALL state WHERE isBugCondition(state.env, state.firewallRules) DO
  result ← applyFix(state)   // set SMDR_PORT=5001 in .env + add firewall rule
  ASSERT result.firewallAllowsPort(5001) = true
  ASSERT result.serviceListeningPort = 5001
  ASSERT result.pbxCanConnect(192.168.0.81, 5001) = true
END FOR
```

**Preservation Checking Property:**

```pascal
// Property: Existing SMDR parsing and logging behaviour is unchanged
FOR ALL X WHERE NOT isBugCondition(X.env, X.firewallRules) DO
  ASSERT F(X) = F'(X)   // call log parsing, DB save, Socket.IO emit unchanged
END FOR
```
