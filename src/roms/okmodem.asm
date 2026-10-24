; Ok-Modem: a modem cartridge for the MSX, the terminal in its ROM.
;
; The modem is a Hayes modem on I/O ports, as A-Prompt's on CP/M:
;   04h  in: status (bit 0 a byte waits, bit 1 ready to send, bit 7 carrier)
;        out: bit 0 is DTR; 0 hangs up
;   05h  data, both ways. AT commands in command mode; the line when online.
; BASIC programs can use it directly: INP(4), INP(5), OUT 5,x.
;
; This ROM is the terminal. With MSX BASIC it adds CALL TERM; with C-BIOS
; (no BASIC) it starts at power-on. It shows the line at 40 columns,
; turning the BBS's ANSI codes into the MSX screen's own and the PC's
; CP437 characters into MSX ones (the table at the end, cptab, is made by
; scripts/build-okmodem.ts from the shapes in the MSX font). CTRL+STOP
; goes back to BASIC and leaves the call up.
;
; Ok-Prompt, MIT licence. Assemble with scripts/build-okmodem.ts.

CHSNS   equ 009Ch       ; Z: no key waiting
CHGET   equ 009Fh       ; A = next key
CHPUT   equ 00A2h       ; prints A (with the MSX's own control codes)
BREAKX  equ 00B7h       ; carry: CTRL+STOP held
INITXT  equ 006Ch       ; SCREEN 0
ERAFNK  equ 00CCh       ; KEY OFF
POSIT   equ 00C6h       ; cursor to column H, row L (from 1)
LINL40  equ 0F3AEh      ; SCREEN 0 width
CSRY    equ 0F3DCh      ; cursor row (from 1)
CSRX    equ 0F3DDh      ; cursor column (from 1)
PROCNM  equ 0FD89h      ; the name after CALL

MSTAT   equ 04h
MDATA   equ 05h
ESC     equ 1Bh

; The terminal's variables, in a frame on the stack, through IX.
VSTATE  equ 0           ; 0 text, 1 after ESC, 2 in ESC [
VNPAR   equ 1           ; which parameter
VPAR    equ 2           ; four parameters
VSAVY   equ 6           ; ESC [ s
VSAVX   equ 7
FRAME   equ 8

        org 4000h
        db "AB"
        dw init         ; INIT
        dw statement    ; STATEMENT: CALL TERM
        dw 0            ; DEVICE
        dw 0            ; TEXT
        ds 6, 0

; ---- start-up -------------------------------------------------------------

; With C-BIOS there is no BASIC to CALL TERM from: run the terminal now.
init:   call iscbios
        ret nz
again:  call term
        jr again

; Z if the BIOS in slot 0 is C-BIOS: it says "C-BIOS" in its first 16K.
iscbios:
        ld hl, 0
        ld bc, 4000h
icnext: ld a, 'C'
        cpir
        jr nz, icno
        push hl
        push bc
        ld de, cbname
        ld b, 5
iccmp:  ld a, (de)
        cp (hl)
        jr nz, icdiff
        inc hl
        inc de
        djnz iccmp
        pop bc
        pop hl
        xor a           ; Z: found
        ret
icdiff: pop bc
        pop hl
        ld a, b
        or c
        jr nz, icnext
icno:   ld a, 1
        or a            ; NZ: not C-BIOS
        ret
cbname: db "-BIOS"

; CALL TERM. BASIC puts the name in PROCNM; carry set means "not ours".
statement:
        push hl
        ld hl, PROCNM
        ld de, termname
stcmp:  ld a, (de)
        cp (hl)
        jr nz, stnot
        or a
        jr z, stours
        inc hl
        inc de
        jr stcmp
stnot:  pop hl
        scf
        ret
stours: call term
        pop hl
        or a            ; handled
        ret
termname: db "TERM", 0

; ---- the terminal ---------------------------------------------------------

term:   push ix
        ld ix, -FRAME
        add ix, sp
        ld sp, ix
        ei
        xor a
        ld (ix+VSTATE), a
        ld (ix+VSAVY), 1
        ld (ix+VSAVX), 1
        ld a, 40
        ld (LINL40), a
        call b_initxt
        call b_erafnk
        ld hl, banner
        call puts
        ld a, 1
        out (MSTAT), a  ; DTR on

tloop:  call b_breakx
        jr c, tleave
        call b_chsns
        jr z, tnokey
        call b_chget
        call sendkey
tnokey: in a, (MSTAT)
        rrca
        jr nc, tloop
        in a, (MDATA)
        call rxchar
        jr tloop

tleave: ld hl, byemsg
        call puts
tdrain: call b_chsns    ; drop the STOP key
        jr z, tdone
        call b_chget
        jr tdrain
tdone:  ld sp, ix
        ld hl, FRAME
        add hl, sp
        ld sp, hl
        pop ix
        ret

; A key from the MSX keyboard: arrows become ANSI, the rest goes as is (the
; MSX's accented letters at 80h-AFh are CP437's too).
sendkey:
        cp 1Ch
        jr z, skright
        cp 1Dh
        jr z, skleft
        cp 1Eh
        jr z, skup
        cp 1Fh
        jr z, skdown
        out (MDATA), a
        ret
skright: ld a, 'C'
        jr skarrow
skleft: ld a, 'D'
        jr skarrow
skup:   ld a, 'A'
        jr skarrow
skdown: ld a, 'B'
skarrow: push af
        ld a, ESC
        out (MDATA), a
        ld a, '['
        out (MDATA), a
        pop af
        out (MDATA), a
        ret

; ---- what the line brings --------------------------------------------------

rxchar: ld c, a
        ld a, (ix+VSTATE)
        or a
        jr nz, rxesc
        ld a, c
        cp ESC
        jr z, rxgotesc
        cp 20h
        jr c, rxctrl
        cp 7Fh
        ret z
        cp 80h
        jr c, rxprint
        sub 80h         ; CP437 to the MSX character set
        ld e, a
        ld d, 0
        ld hl, cptab
        add hl, de
        ld a, (hl)
rxprint: cp 20h
        jp nc, b_chput
        push af         ; MSX graphic characters 00h-1Fh: 01h, then +40h
        ld a, 1
        call b_chput
        pop af
        add a, 40h
        jp b_chput

; Controls the MSX screen shares with a terminal: bell, BS, tab, LF, FF, CR.
rxctrl: cp 07h
        jp z, b_chput
        cp 08h
        jp z, b_chput
        cp 09h
        jp z, b_chput
        cp 0Ah
        jp z, b_chput
        cp 0Ch
        jp z, b_chput
        cp 0Dh
        jp z, b_chput
        ret

rxgotesc: ld (ix+VSTATE), 1
        ret

rxesc:  cp 1
        jr nz, rxcsi
        ld a, c         ; after ESC: only ESC [ is understood
        cp '['
        jr nz, rxreset
        ld (ix+VSTATE), 2
        xor a
        ld (ix+VNPAR), a
        ld (ix+VPAR), a
        ld (ix+VPAR+1), a
        ld (ix+VPAR+2), a
        ld (ix+VPAR+3), a
        ret
rxreset: xor a
        ld (ix+VSTATE), a
        ret

rxcsi:  ld a, c
        cp '0'
        jr c, rxnotdig
        cp '9'+1
        jr nc, rxnotdig
        call paraddr    ; parameter = parameter * 10 + digit, at most 255
        ld a, (hl)
        cp 26
        jr nc, rxbig
        ld b, a
        add a, a
        add a, a
        add a, b
        add a, a        ; x 10
        ld b, a
        ld a, c
        sub '0'
        add a, b
        jr nc, rxsetp
rxbig:  ld a, 255
rxsetp: ld (hl), a
        ret
rxnotdig: cp ';'
        jr nz, rxnotsemi
        ld a, (ix+VNPAR)
        cp 3
        ret nc
        inc (ix+VNPAR)
        ret
rxnotsemi: cp 40h
        jr c, rxkeep    ; ? and other parameter bytes: ignored
        cp 7Fh
        jr nc, rxreset
        call csi
        jr rxreset
rxkeep: cp 20h
        jr c, rxreset   ; a control in the middle: give up the sequence
        ret

; HL = the current parameter.
paraddr: push ix
        pop hl
        ld de, VPAR
        add hl, de
        ld e, (ix+VNPAR)
        add hl, de
        ret

; The final byte of ESC [ ... (in C).
csi:    ld a, c
        cp 'H'
        jr z, csipos
        cp 'f'
        jr z, csipos
        cp 'A'
        ld b, 1Eh
        jr z, csimove
        cp 'B'
        ld b, 1Fh
        jr z, csimove
        cp 'C'
        ld b, 1Ch
        jr z, csimove
        cp 'D'
        ld b, 1Dh
        jr z, csimove
        cp 'J'
        jr z, csierase
        cp 'K'
        jr z, csiline
        cp 's'
        jr z, csisave
        cp 'u'
        jr z, csirest
        cp 'n'
        jr z, csireport
        ret             ; m (colours) and the rest: ignored

csipos: ld a, (ix+VPAR)         ; row
        call atleast1
        cp 24
        jr c, cprow
        ld a, 24
cprow:  ld l, a
        ld a, (ix+VPAR+1)       ; column
        call atleast1
        cp 40
        jr c, cpcol
        ld a, 40
cpcol:  ld h, a
        jp b_posit

csimove: ld a, (ix+VPAR)
        call atleast1
cmloop: push af
        ld a, b
        call b_chput
        pop af
        dec a
        jr nz, cmloop
        ret

csierase: ld a, (ix+VPAR)
        cp 2
        ld a, 0Ch       ; ESC [ 2 J: clear the screen
        jp z, b_chput
        ld a, (ix+VPAR)
        or a
        ret nz          ; ESC [ 1 J: not on the MSX
        ld a, ESC       ; ESC [ J: to the end of the screen
        call b_chput
        ld a, 'J'
        jp b_chput

csiline: ld a, (ix+VPAR)
        cp 2
        ld a, 'l'       ; ESC [ 2 K: the whole line
        jr z, clesc
        ld a, (ix+VPAR)
        or a
        ret nz
        ld a, 'K'       ; ESC [ K: to the end of the line
clesc:  push af
        ld a, ESC
        call b_chput
        pop af
        jp b_chput

csisave: ld a, (CSRY)
        ld (ix+VSAVY), a
        ld a, (CSRX)
        ld (ix+VSAVX), a
        ret
csirest: ld l, (ix+VSAVY)
        ld h, (ix+VSAVX)
        jp b_posit

; ESC [ 6 n: say where the cursor is (BBSes find the screen size this way).
csireport: ld a, (ix+VPAR)
        cp 6
        ret nz
        ld a, ESC
        out (MDATA), a
        ld a, '['
        out (MDATA), a
        ld a, (CSRY)
        call senddec
        ld a, ';'
        out (MDATA), a
        ld a, (CSRX)
        call senddec
        ld a, 'R'
        out (MDATA), a
        ret

; Sends A (0-255) in decimal.
senddec: ld c, 0        ; whether a digit went out
        ld b, 100
        call sdigit
        ld b, 10
        call sdigit
        add a, '0'
        out (MDATA), a
        ret
sdigit: ld e, '0'
sdloop: cp b
        jr c, sdout
        sub b
        inc e
        jr sdloop
sdout:  ld d, a
        ld a, e
        cp '0'
        jr nz, sdsend
        ld a, c
        or a
        jr z, sdskip    ; no leading zeros
        ld a, e
sdsend: out (MDATA), a
        ld c, 1
sdskip: ld a, d
        ret

atleast1: or a
        ret nz
        inc a
        ret

; Prints the zero-terminated text at HL.
puts:   ld a, (hl)
        or a
        ret z
        call b_chput
        inc hl
        jr puts

; BIOS calls that keep IX (C-BIOS's routines are free to use it).
b_chput: push ix
        push hl
        push de
        push bc
        call CHPUT
        pop bc
        pop de
        pop hl
        pop ix
        ret
b_chget: push ix
        call CHGET
        pop ix
        ret
b_chsns: push ix
        call CHSNS
        pop ix
        ret
b_breakx: push ix
        call BREAKX
        pop ix
        ret
b_posit: push ix
        call POSIT
        pop ix
        ret
b_initxt: push ix
        call INITXT
        pop ix
        ret
b_erafnk: push ix
        call ERAFNK
        pop ix
        ret

banner: db 0Ch
        db "Ok-Modem  - Hayes modem, ports 04h/05h", 0Dh, 0Ah
        db 0Dh, 0Ah
        db "  ATI           the phone book", 0Dh, 0Ah
        db "  ATDT 1        call board 1", 0Dh, 0Ah
        db "  ATDT DEEPSEEK the AI board", 0Dh, 0Ah
        db "  +++  ATH      hang up", 0Dh, 0Ah
        db "  CTRL+STOP     back to BASIC", 0Dh, 0Ah
        db 0Dh, 0Ah, 0
byemsg: db 0Dh, 0Ah, "Back to BASIC; the line stays up.", 0Dh, 0Ah, 0

; cptab: CP437 80h-FFh to MSX codes, appended by scripts/build-okmodem.ts.
