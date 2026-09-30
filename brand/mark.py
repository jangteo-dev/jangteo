# Jangteo mark: a GIWA roof-tile gate (the name GIWA means roof tile) under a red sun.
INK="#1d2230"; PAPER="#eef0ec"; GOLD="#d9a021"; RED="#c8303f"; BLUE="#3558b8"
def mark(bg=True, fg_paper=PAPER, bgc=INK):
    parts=[]
    if bg: parts.append(f'<rect width="512" height="512" rx="116" fill="{bgc}"/>')
    parts.append(f'<circle cx="256" cy="104" r="22" fill="{RED}"/>')
    # hipped giwa roof: a straight ridge (yongmaru) and eaves that lift at both ends (cheoma)
    parts.append(f'<path fill="{GOLD}" d="M176 176h160c22 34 58 56 104 58 10 0 18-4 26-12-4 20-18 34-40 40-50 12-120 16-170 16s-120-4-170-16c-22-6-36-20-40-40 8 8 16 12 26 12 46-2 82-24 104-58z"/>')
    parts.append(f'<path fill="{GOLD}" d="M150 164c0-8 6-12 14-12h184c8 0 14 4 14 12v4c0 4-4 8-8 8H158c-4 0-8-4-8-8z"/>')
    parts.append(f'<path d="M150 168l-10-14M362 168l10-14" stroke="{GOLD}" stroke-width="10" stroke-linecap="round"/>')
    parts.append(f'<path d="M206 190v52M256 190v58M306 190v52" stroke="{bgc if bg else INK}" stroke-width="5" stroke-linecap="round" opacity=".22"/>')
    parts.append(f'<rect x="120" y="266" width="272" height="20" rx="6" fill="{GOLD}"/>')
    parts.append(f'<rect x="146" y="300" width="30" height="134" rx="5" fill="{fg_paper}"/>')
    parts.append(f'<rect x="336" y="300" width="30" height="134" rx="5" fill="{fg_paper}"/>')
    parts.append(f'<rect x="196" y="300" width="120" height="24" rx="4" fill="{RED}"/>')
    parts.append(f'<rect x="196" y="336" width="120" height="98" rx="4" fill="{BLUE}"/>')
    parts.append(f'<path d="M256 336v98" stroke="{bgc if bg else INK}" stroke-width="6" opacity=".55"/>')
    return "".join(parts)
def svg(inner, w=512, h=512, vb=None):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb or f"0 0 {w} {h}"}" width="{w}" height="{h}">{inner}</svg>'
if __name__=="__main__":
    open("mark.svg","w").write(svg(mark()))
    open("preview.html","w").write('<body style="margin:0;background:#888;display:flex;gap:30px;padding:30px">'+svg(mark())+svg(mark(),64,64,"0 0 512 512")+svg(mark(),32,32,"0 0 512 512")+'</body>')
