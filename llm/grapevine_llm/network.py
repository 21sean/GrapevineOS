"""Defense in depth: evaluator and tracing dependencies cannot open remote sockets."""
import ipaddress
import sys


def _local(host) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def audit(event, args):
    if event == "socket.connect":
        address = args[1]
        if not isinstance(address, tuple) or not _local(address[0]):
            raise PermissionError("LLM runtime permits loopback sockets only")
    elif event == "socket.getaddrinfo" and not _local(args[0]):
        raise PermissionError("LLM runtime permits loopback DNS names only")


sys.addaudithook(audit)
