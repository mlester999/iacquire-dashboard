"use client";
import { Moon,Sun } from "lucide-react";
import { useTheme } from "@/components/providers";
import { Button } from "@/components/ui/button";
/** Safe development preview switch using the same application theme provider. */
export function PreviewTheme(){const {resolved,setTheme}=useTheme();return <Button size="sm" variant="secondary" onClick={()=>setTheme(resolved==="light"?"dark":"light")} aria-label={`Preview ${resolved==="light"?"dark":"light"} theme`}>{resolved==="light"?<Moon className="size-3.5"/>:<Sun className="size-3.5"/>}{resolved==="light"?"Dark":"Light"} preview</Button>;}
