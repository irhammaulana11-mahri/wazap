# Test Cases

  -------------------------------------------------------------------------
  ID                      Scenario                Expected result
  ----------------------- ----------------------- -------------------------
  AUTH-001                Register new user       User and tenant created
                                                  transactionally

  TEN-001                 Cross-tenant session    Denied/not found
                          read                    

  TEN-002                 Cross-tenant send using Denied
                          session ID              

  SES-001                 Create session          Session enters lifecycle

  SES-002                 QR refresh              Authorized client
                                                  receives current QR only

  SES-003                 Temporary disconnect    Reconnect without
                                                  deleting auth state

  SES-004                 Engine crash            Lease recovery without
                                                  dual owner

  SES-005                 Delete session          Ownership revoked and
                                                  credentials cleaned by
                                                  policy

  MSG-001                 Submit valid send       HTTP 202 and job ID

  MSG-002                 Duplicate idempotency   Same logical job/result
                          key                     

  MSG-003                 Concurrent workers      No duplicate job claim
                          claim                   

  MSG-004                 Ambiguous send outcome  UNKNOWN/reconciliation,
                                                  not blind duplicate retry

  QUE-001                 Tenant A queue flood    Tenant B receives fair
                                                  scheduling

  WH-001                  Webhook endpoint fails  Bounded retry and
                                                  delivery log

  SEC-001                 API key revoked         Access denied

  SEC-002                 SSRF webhook URL        Unsafe target blocked

  RT-001                  Unauthorized socket     Join denied
                          room                    

  OPS-001                 Restart engine          Sessions recover safely
  -------------------------------------------------------------------------
