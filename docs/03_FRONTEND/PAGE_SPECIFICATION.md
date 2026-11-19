# Frontend Page Specification

  -----------------------------------------------------------------------
  Page                    Main components         API dependency
  ----------------------- ----------------------- -----------------------
  Register/Login          Forms, validation       `/auth/*`

  Dashboard               KPI, recent jobs,       `/usage/*`,
                          session health          `/sessions`,
                                                  `/messages`

  Sessions                Table/cards, add,       `/sessions/*`
                          detail, QR, actions     

  Send Message            Session selector,       `/messages/send`
                          recipient, composer     

  Message History         Filter, pagination,     `/messages`
                          detail                  

  Chats                   Chat list, message      `/chats/*`
                          timeline                

  Contacts                Search, pagination      `/contacts`

  Webhooks                Endpoint CRUD, delivery `/webhooks/*`
                          history                 

  API Keys                Create, reveal once,    `/api-keys`
                          revoke                  

  Usage                   Session/message usage   `/usage/*`

  Team                    Membership and role     tenant membership API
                          management              

  Settings                Profile, tenant         tenant settings API
                          configuration           
  -----------------------------------------------------------------------

## Page implementation checklist

-   Confirm API contract before coding.
-   Use typed API client.
-   Implement permission-aware actions.
-   Handle Socket.IO reconnection.
-   Do not assume realtime event always arrives; refetch authoritative
    state after reconnect.
-   Add component and page tests.
