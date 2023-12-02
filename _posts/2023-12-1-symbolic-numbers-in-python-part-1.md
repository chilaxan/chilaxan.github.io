---
layout: post
title:  "Symbolic Numbers In Python - Part 1"
categories: Python
---

A while ago I wanted to see if I could add symbolic numbers to Python. This would mean that something like `one` would equal `1` and `two_hundred_and_five` would equal `205`.

The obvious option is to just do the following:
```py
one = 1
two = 2
three = 3
...
forty_two_thousand_one_hundred_and_twenty_two = 42122
# and on to infinity?
```
But this rapidly fills up disk space (and would be a bit insane).

A better way would be to use a module level getattr like this:
```py
# numbers.py

def parse_int(textnum, numwords={}):
    # parse symbolic number into integer
    # https://ataiva.com/how-to-convert-numeric-words-into-numbers-using-python/
    if not numwords:
        units = [
            "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
            "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
            "sixteen", "seventeen", "eighteen", "nineteen",
        ]
        tens = [
            "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", 
            "eighty", "ninety"
        ]
        scales = ["hundred", "thousand", "million", "billion", "trillion"]
        numwords["and"] = (1, 0)
        for idx, word in enumerate(units):
            numwords[word] = (1, idx)

        for idx, word in enumerate(tens):
            numwords[word] = (1, idx * 10)

        for idx, word in enumerate(scales):
            numwords[word] = (10 ** (idx * 3 or 2), 0)

    current = result = 0
    for word in textnum.split('_'):
        if word not in numwords:
          raise ValueError('could not convert to number')
        scale, increment = numwords[word]
        current = current * scale + increment
        if scale > 100:
            result += current
            current = 0
    return result + current

def __getattr__(key):
    number = parse_number(key)
    if number is None:
        raise AttributeError(key)
    return number
```
And then use it as follows:
```py
# some_other_file.py
from numbers import one, forty_two_thousand
```
This is quite pythonic, but not quite as magic as I wanted it to be. Another obvious solution would be using a global object with a `__getattr__` that performs the number parsing. Eventually I determined the best way to add the numbers as though they were constants would require some runtime trickery. My desired syntax for the literals was the different words, seperated with `_`, ex: `one_hundred_twenty_four` would equal `124`. Since this syntax would be the same as a name lookup, I researched how variable lookups work in CPython.
```sh
➜  ~ echo "one_hundred_twenty_four" | python3 -m dis
  0           0 RESUME                   0

  1           2 LOAD_NAME                0 (one_hundred_twenty_four)
              4 POP_TOP
              6 LOAD_CONST               0 (None)
              8 RETURN_VALUE
➜  ~ 
```
We can see the important part here is the `LOAD_NAME` opcode. We can see the implementation in [bytecodes.c](https://github.com/python/cpython/blob/698b4b73bc2f6d2de96dac04df5102ac468e02c0/Python/bytecodes.c#L1235-L1295). Glancing at the implementation, it is clear that `LOAD_NAME` is a sort of catch all, first it checks `locals`, then `globals`, then `builtins`. We can pull these different parts out and look for something we can influence.

Load from `locals`:
```c
PyObject *mod_or_class_dict = LOCALS();
if (mod_or_class_dict == NULL) {
    _PyErr_SetString(tstate, PyExc_SystemError,
                        "no locals found");
    ERROR_IF(true, error);
}
PyObject *name = GETITEM(frame->f_code->co_names, oparg);
if (PyDict_CheckExact(mod_or_class_dict)) {
    v = PyDict_GetItemWithError(mod_or_class_dict, name);
    if (v != NULL) {
        Py_INCREF(v);
    }
    else if (_PyErr_Occurred(tstate)) {
        goto error;
    }
}
else {
    v = PyObject_GetItem(mod_or_class_dict, name);
    if (v == NULL) {
        if (!_PyErr_ExceptionMatches(tstate, PyExc_KeyError)) {
            goto error;
        }
        _PyErr_Clear(tstate);
    }
}
```
Load from `globals`:
```c
v = PyDict_GetItemWithError(GLOBALS(), name);
if (v != NULL) {
    Py_INCREF(v);
}
else if (_PyErr_Occurred(tstate)) {
    goto error;
}
```
Load from `builtins`:
```c
if (PyDict_CheckExact(BUILTINS())) {
    v = PyDict_GetItemWithError(BUILTINS(), name);
    if (v == NULL) {
        if (!_PyErr_Occurred(tstate)) {
            format_exc_check_arg(
                    tstate, PyExc_NameError,
                    NAME_ERROR_MSG, name);
        }
        goto error;
    }
    Py_INCREF(v);
}
else {
    v = PyObject_GetItem(BUILTINS(), name);
    if (v == NULL) {
        if (_PyErr_ExceptionMatches(tstate, PyExc_KeyError)) {
            format_exc_check_arg(
                        tstate, PyExc_NameError,
                        NAME_ERROR_MSG, name);
        }
        goto error;
    }
}
```
So right off the bat we have three places to inspect. The load from `locals` seems to be the most complicated, and `locals` can change based on state so it would not be easy to place a hook in there. `globals` is similar, and seems to just take the current frame's `GLOBALS()` dictionary and pass it into `PyDict_GetItemWithError`. (It is possible to install a hook here using some memory corruption, more on that in part 2). But the lowest hanging fruit is the third load, from `builtins`. The first thing it does is check if `BUILTINS()` is a dictionary object. Normally, it is, but if it is not, the code continues down and uses `PyObject_GetItem` on `BUILTINS()`. From here we have a clear path. we can change the value returned by `BUILTINS()` by changing the `__builtins__` value inside of a given frame's globals. By inserting a custom dictionary subclass, we can install code to run when a given key is not found. Python actually provides a simple way to do this, with `__missing__`. On dictionary subclasses, `__missing__` is called if a given key is not found within the dictionary. Knowing this, we can write a simple dictionary subclass using `__missing__` to call our `parse_int` function.
```py
class missing_hook(dict):
    def __init__(self, *args, missing=lambda self, arg: None, **kwargs):
        super().__init__(*args, **kwargs)
        self.missing = missing

    def __missing__(self, key):
        try:
            return self.missing(self, key)
        except Exception:
            raise KeyError(f"name {key!r} is not defined") from None
```
Now, all we need to do is install this `missing_hook` class as `__builtins__` in our target frame. We can use the following to do that:
```py
def init_symbolic_numbers():
    frame_globals = sys._getframe(1).f_globals
    frame_globals['__builtins__'] = missing_hook(builtins.__dict__, missing=parse_int)
```
`init_symbolic_numbers` when called, will grab the frame *above* it's globals dictionary, and replace `__builtins__` with an instance of `missing_hook`. Testing this shows that it works!
```py
➜  ~/Desktop python3.12                       
Python 3.12.0 (main, Oct  5 2023, 15:44:07) [Clang 14.0.3 (clang-1403.0.22.14.1)] on darwin
Type "help", "copyright", "credits" or "license" for more information.
>>> from numbers import init_symbolic_numbers
>>> init_symbolic_numbers()
>>> one_hundred_and_twenty_five
125
>>>
```
This works pretty well here, but we will start to notice some problems when we try to use it in a file
```py
# main.py
from numbers import init_symbolic_numbers
init_symbolic_numbers()

print(one_hundred_and_twenty_five)
```
```sh
➜  ~/Desktop python3.12 main.py           
Traceback (most recent call last):
  File "/Users/chilaxan/Desktop/main.py", line 4, in <module>
    print(one_hundred_and_twenty_five)
          ^^^^^^^^^^^^^^^^^^^^^^^^^^^
NameError: name 'one_hundred_and_twenty_five' is not defined
```
This is because CPython copies a reference to the builtins dictionary when it is building the frame, which happens before our code runs. So while this approach works for the repl, we will need to try something different to get it working everywhere.