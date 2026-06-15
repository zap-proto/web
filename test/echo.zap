package echo

# EchoArgs — params for EchoCap.echo(msg) @0.
struct EchoArgs {
    Msg  text   @0
}

# EchoResult — results for EchoCap.echo -> (msg) @0.
struct EchoResult {
    Msg  text   @0
}
