import { queryRequired } from "../shared/dom";
import { HomeApp } from "./app/HomeApp";

new HomeApp(queryRequired<HTMLDivElement>("#app")).start();
