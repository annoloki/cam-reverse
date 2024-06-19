#!/bin/bash

cam=FTZ814978FDCCF

docmd() {
	curl http://localhost:5000/$cam/$1/$2
}
pancmd() {
	docmd pancmd "$@"
}
cps=0

while read -n 1 l ; do
	unset cmd
	echo -n ' '
	case ${l,,} in
		r) echo Fast ; cmd=0/15/2 ;;
		f) echo Med  ; cmd=0/15/10;;
		v) echo Slow ; cmd=0/15/50;;
		w) echo Up   ; cmd=0/0/0  ;;
		s) echo Stop ; cmd=0/12/0 ;;
		x) echo Down ; cmd=0/1/0  ;;
		a) echo Left ; cmd=0/2/0  ;;
		d) echo Right; cmd=0/3/0  ;;
		1) echo Go 1 ; cmd=1/1/1  ;;
		2) echo Go 2 ; cmd=1/1/2  ;;
		3) echo Go 3 ; cmd=1/1/3  ;;
		4) echo Go 4 ; cmd=1/1/4  ;;
		5) echo Go 5 ; cmd=1/1/5  ;;
		6) echo Go 6 ; cmd=1/1/6  ;;
		i) echo Toggle IR;docmd ir;;
		l) echo Toggle Light;docmd light ;;
		c) echo Custom ; read cmd ;;
	esac
	[[ -n $cmd ]] && docmd pancmd $cmd 
	echo -n $'\n> '
done
