package echo

# @openapi:version 1.0.0
# @openapi:server http://127.0.0.1/v1

# Request/response payloads for the EchoService.echo method.
struct EchoIn {
    Msg  text   @0
}

struct EchoOut {
    Msg  text   @0
}

# One method whose ordinal auto-assigns to 1. zapgen --emit=ts,openapi codegens
# both the EchoService Client/Server bindings AND the OpenAPI 3.1 doc whose
# POST /echo-service/echo path httpServe must serve.
interface EchoService {
    echo(req: EchoIn) returns (resp: EchoOut)
}
