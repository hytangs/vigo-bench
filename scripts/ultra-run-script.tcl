set timeout -1
spawn -noecho $env(VIGO_ULTRA_BINARY)
expect "> "
send -- "runScript $env(VIGO_ULTRA_SCRIPT)\r"
expect {
    "> " { send -- "quit\r"; expect eof }
    eof {}
}
# EOF alone is not success: the native importer may have aborted.
set result [wait]
if {[lindex $result 2] != 0 || [llength $result] > 4} {
    puts stderr "ULTRA native process failed: $result"
    exit 1
}
exit [lindex $result 3]
